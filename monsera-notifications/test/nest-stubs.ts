// No-op stand-ins for the NestJS decorators used by the classes under test.
const decorator = () => () => undefined;
export const Injectable = decorator;
export const Inject = decorator;
export const InjectQueue = decorator;
export const Processor = decorator;
export const Controller = decorator;
export const Get = decorator;
export class WorkerHost {}
export class Logger {
  constructor(_context?: string) {}
  log() {}
  warn() {}
  error() {}
}
