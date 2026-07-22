export interface InfiniteBenchItem {
  id: number
  context: string
  input: string
  answer: Array<string | number>
  options?: string[]
}