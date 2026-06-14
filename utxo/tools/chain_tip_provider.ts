export interface UtxoChainTipProvider {
  readonly name: string;
  getChainTipHeight(): Promise<number>;
}
