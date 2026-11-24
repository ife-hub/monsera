-- Spec §10: a full transaction-level audit trail, immutable, covering every
-- credit event, decision, settlement movement and registry entry.
--
-- These tables become append-only at the database level, so no API bug,
-- admin endpoint or ad-hoc script can rewrite history. The only updates
-- allowed are the two one-time stamps the platform itself needs:
--   ObligationRecovery.sweptAt    (NULL -> timestamp, by the daily sweep)
--   ObligationSuspension.endedAt  (NULL -> timestamp, when a suspension ends)
-- Corrections are made by appending a new, compensating entry.

CREATE OR REPLACE FUNCTION monsera_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % rows cannot be %d (spec section 10 immutable audit trail)', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "Audit"
  FOR EACH ROW EXECUTE FUNCTION monsera_append_only();
CREATE TRIGGER decision_log_append_only BEFORE UPDATE OR DELETE ON "DecisionLog"
  FOR EACH ROW EXECUTE FUNCTION monsera_append_only();
CREATE TRIGGER wallet_transaction_append_only BEFORE UPDATE OR DELETE ON "WalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION monsera_append_only();
CREATE TRIGGER vend_record_revision_append_only BEFORE UPDATE OR DELETE ON "VendRecordRevision"
  FOR EACH ROW EXECUTE FUNCTION monsera_append_only();
CREATE TRIGGER reconciliation_run_append_only BEFORE UPDATE OR DELETE ON "ReconciliationRun"
  FOR EACH ROW EXECUTE FUNCTION monsera_append_only();

-- Recovery rows: never deleted; the only permitted change is stamping sweptAt once.
CREATE OR REPLACE FUNCTION monsera_recovery_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only: ObligationRecovery rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sweptAt" IS NOT NULL OR NEW."sweptAt" IS NULL
     OR (OLD.id, OLD."obligationId", OLD."recoveryTransactionId", OLD."amountKobo", OLD."principalKobo",
         OLD."serviceKobo", OLD."walletBRecordId", OLD."createdAt")
        IS DISTINCT FROM
        (NEW.id, NEW."obligationId", NEW."recoveryTransactionId", NEW."amountKobo", NEW."principalKobo",
         NEW."serviceKobo", NEW."walletBRecordId", NEW."createdAt") THEN
    RAISE EXCEPTION 'append-only: ObligationRecovery only allows sweptAt to be stamped once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER obligation_recovery_guard BEFORE UPDATE OR DELETE ON "ObligationRecovery"
  FOR EACH ROW EXECUTE FUNCTION monsera_recovery_guard();

-- Suspension events: never deleted; the only permitted change is closing one once.
CREATE OR REPLACE FUNCTION monsera_suspension_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only: ObligationSuspension rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."endedAt" IS NOT NULL OR NEW."endedAt" IS NULL
     OR (OLD.id, OLD."obligationId", OLD.reason, OLD."startedAt", OLD."createdAt")
        IS DISTINCT FROM
        (NEW.id, NEW."obligationId", NEW.reason, NEW."startedAt", NEW."createdAt") THEN
    RAISE EXCEPTION 'append-only: ObligationSuspension only allows endedAt to be set once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER obligation_suspension_guard BEFORE UPDATE OR DELETE ON "ObligationSuspension"
  FOR EACH ROW EXECUTE FUNCTION monsera_suspension_guard();
