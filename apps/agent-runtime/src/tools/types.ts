export interface Tool {
  name: string;
  description: string;
  /** JSON-Schema：直接喂给模型做 function-calling。 */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}
