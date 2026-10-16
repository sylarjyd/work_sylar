/** 嵌入网关：把一批文本映射为等长向量数组（顺序与输入一致）。 */
export interface EmbeddingGateway {
  /** 维度（须与 `KbChunk.vector` 列维度一致）。 */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
