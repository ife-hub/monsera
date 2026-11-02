import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { ListFloatLedgerDto } from './dto/list-float-ledger.dto';
import { CreateFloatLedgerDto } from './dto/create-float-ledger.dto';
import { UpdateFloatLedgerDto } from './dto/update-float-ledger.dto';

// Names inferred from usage, move to config / rename to match your domain.
const FLOAT_WALLET_ID = 3; // credited by finance-house top-ups, debited when float is allocated to a disco
const ALLOCATION_WALLET_ID = 1; // credited when float is allocated to a disco

type Tx = Prisma.TransactionClient;

@Injectable()
export class FloatLedgerService {
  private readonly logger = new Logger(FloatLedgerService.name);

  constructor(private prisma: PrismaService) {}

  // ---------- reads ----------

  async list(query: ListFloatLedgerDto, actor: JwtPayload) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where = await this.scopeFor(actor);

    const [total, data] = await this.prisma.$transaction([
      this.prisma.float_Ledger.count({ where }),
      this.prisma.float_Ledger.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      success: true,
      data,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: number, actor: JwtPayload) {
    const scope = await this.scopeFor(actor);
    const entry = await this.prisma.float_Ledger.findFirst({ where: { id, ...scope } });
    if (!entry) throw new NotFoundException({ success: false, message: 'Not found' });
    return { success: true, data: entry };
  }

  // ---------- writes ----------

  async create(dto: CreateFloatLedgerDto, actor: JwtPayload) {
    try {
      const data =
        dto.discoAdminId != null
          ? await this.allocateToDisco(dto, actor)
          : await this.creditFromFinanceHouse(dto, actor);
      return { success: true, data };
    } catch (error) {
      this.rethrow(error, 'Failed to create float ledger entry');
    }
  }

  async update(id: number, dto: UpdateFloatLedgerDto, actor: JwtPayload) {
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const entry = await tx.float_Ledger.update({
          where: { id },
          data: {
            ...(dto.date !== undefined && { date: new Date(dto.date) }),
            ...(dto.referenceId !== undefined && { referenceId: dto.referenceId }),
            ...(dto.amount !== undefined && { amount: new Prisma.Decimal(dto.amount) }),
            ...(dto.type !== undefined && { type: dto.type }),
            ...(dto.currentFloatBalance !== undefined && {
              currentFloatBalance: new Prisma.Decimal(dto.currentFloatBalance),
            }),
          },
        });
        await this.audit(tx, actor, `Updated float ledger entry ${id}`);
        return entry;
      });
      return { success: true, data: updated };
    } catch (error) {
      this.rethrow(error, 'Failed to update float ledger');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.float_Ledger.delete({ where: { id } });
        await this.audit(tx, actor, `Deleted float ledger entry ${id}`);
      });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete float ledger');
    }
  }

  // ---------- create: the two paths ----------

  /** Finance house tops up the float: ledger entry + FLOAT wallet increases. */
  private async creditFromFinanceHouse(dto: CreateFloatLedgerDto, actor: JwtPayload) {
    const financeHouse = await this.prisma.financeHouse.findUnique({ where: { userId: actor.userId } });
    if (!financeHouse) {
      throw new NotFoundException({ success: false, message: 'Finance house not found for this user' });
    }

    const amount = new Prisma.Decimal(dto.amount);

    return this.runSerializable(async (tx) => {
      await this.assertReferenceFree(tx, dto.referenceId);

      const wallet = await tx.wallet.findUnique({ where: { id: FLOAT_WALLET_ID } });
      if (!wallet) throw new NotFoundException({ success: false, message: 'Wallet not found' });

      const floatBalance = await this.latestFloatBalance(tx);

      const floatLedger = await tx.float_Ledger.create({
        data: {
          date: new Date(),
          referenceId: dto.referenceId,
          amount,
          type: dto.type,
          currentFloatBalance: floatBalance.add(amount),
          attachmentUrl: dto.attachmentUrl ?? null,
          financeHouseId: financeHouse.id,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: FLOAT_WALLET_ID },
        data: { balance: new Prisma.Decimal(wallet.balance ?? 0).add(amount), updatedAt: new Date() },
      });

      await tx.audit.create({
        data: {
          userId: actor.userId,
          employeeName: financeHouse.name,
          emailAddress: actor.email,
          activity: `Added float ledger credit entry: ${dto.referenceId} - ₦${amount.toNumber().toLocaleString()}`,
        },
      });

      return { floatLedger, wallet: updatedWallet };
    });
  }

  /** Admin allocates float to a disco: FLOAT wallet down, ALLOCATION wallet and disco balance up. */
  private async allocateToDisco(dto: CreateFloatLedgerDto, actor: JwtPayload) {
    if (actor.userType !== UserType.MONSERA_ADMIN) {
      throw new ForbiddenException({ success: false, message: 'Only Monsera admins can allocate float to a disco' });
    }

    const amount = new Prisma.Decimal(dto.amount);

    return this.runSerializable(async (tx) => {
      await this.assertReferenceFree(tx, dto.referenceId);

      const floatWallet = await tx.wallet.findUnique({ where: { id: FLOAT_WALLET_ID } });
      if (!floatWallet) throw new NotFoundException({ success: false, message: 'Wallet not found' });

      const floatWalletBalance = new Prisma.Decimal(floatWallet.balance ?? 0);
      if (floatWalletBalance.lt(amount)) {
        throw new BadRequestException({ success: false, message: 'Insufficient wallet balance for this deduction' });
      }

      // discoAdminId from the client is the disco's userId (kept from the old code)
      const disco = await tx.discoAdmin.findUnique({ where: { userId: dto.discoAdminId } });
      if (!disco) throw new NotFoundException({ success: false, message: 'Disco not found' });

      const allocationWallet = await tx.wallet.findUnique({ where: { id: ALLOCATION_WALLET_ID } });
      if (!allocationWallet) throw new NotFoundException({ success: false, message: 'Wallet not found' });

      const floatBalance = await this.latestFloatBalance(tx);

      const floatLedger = await tx.float_Ledger.create({
        data: {
          date: new Date(),
          referenceId: dto.referenceId,
          amount,
          type: dto.type,
          currentFloatBalance: floatBalance.sub(amount),
          attachmentUrl: dto.attachmentUrl ?? null,
          discoAdminId: disco.id,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: FLOAT_WALLET_ID },
        data: { balance: floatWalletBalance.sub(amount), updatedAt: new Date() },
      });

      await tx.wallet.update({
        where: { id: ALLOCATION_WALLET_ID },
        data: { balance: new Prisma.Decimal(allocationWallet.balance ?? 0).add(amount), updatedAt: new Date() },
      });

      await tx.discoAdmin.update({
        where: { id: disco.id },
        data: { balance: new Prisma.Decimal(disco.balance ?? 0).add(amount), updatedAt: new Date() },
      });

      await tx.audit.create({
        data: {
          userId: actor.userId,
          employeeName: actor.email,
          emailAddress: actor.email,
          activity: `Allocated float to disco ${disco.name}: ${dto.referenceId} - ₦${amount.toNumber().toLocaleString()}`,
        },
      });

      return { floatLedger, wallet: updatedWallet };
    });
  }

  // ---------- helpers ----------

  /** Which ledger rows this user may see. */
  private async scopeFor(actor: JwtPayload): Promise<Prisma.Float_LedgerWhereInput> {
    switch (actor.userType) {
      case UserType.FINANCE_HOUSE: {
        const financeHouse = await this.prisma.financeHouse.findUnique({ where: { userId: actor.userId } });
        if (!financeHouse) throw new NotFoundException({ success: false, message: 'Finance house not found' });
        return { financeHouseId: financeHouse.id };
      }
      case UserType.DISCO_ADMIN: {
        const disco = await this.prisma.discoAdmin.findUnique({ where: { userId: actor.userId } });
        if (!disco) throw new NotFoundException({ success: false, message: 'Disco admin not found' });
        return { discoAdminId: disco.id };
      }
      case UserType.MONSERA_ADMIN:
        return {};
      default:
        throw new ForbiddenException({ success: false, message: 'Unauthorized' });
    }
  }

  private runSerializable<T>(fn: (tx: Tx) => Promise<T>) {
    return this.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async assertReferenceFree(tx: Tx, referenceId: string) {
    const existing = await tx.float_Ledger.findFirst({ where: { referenceId } });
    if (existing) throw new BadRequestException({ success: false, message: 'Reference ID already exists' });
  }

  /** The float balance is one running total across all entries (same as the old code). */
  private async latestFloatBalance(tx: Tx) {
    const last = await tx.float_Ledger.findFirst({ orderBy: [{ date: 'desc' }, { id: 'desc' }] });
    return new Prisma.Decimal(last?.currentFloatBalance ?? 0);
  }

  private audit(tx: Tx, actor: JwtPayload, activity: string) {
    return tx.audit.create({
      data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      switch (error.code) {
        case 'P2002':
          throw new BadRequestException({ success: false, message: 'Reference ID already exists' });
        case 'P2003':
          throw new BadRequestException({ success: false, message: 'Invalid finance house or disco reference' });
        case 'P2025':
          throw new NotFoundException({ success: false, message: 'Float ledger entry not found' });
        case 'P2034':
          // serialization conflict: two writers raced, safe for the client to retry
          throw new ConflictException({ success: false, message: 'Concurrent update, please retry' });
      }
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}