export class DurableObject<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  async run(_event: any, _step: any): Promise<unknown> {
    return undefined;
  }
}
