import localEngramProvider from '../../../../memorybench-integration/src/providers/local-engram/index';

export class LocalEngramProvider {
  name = 'local-engram'
  prompts = localEngramProvider.prompts
  concurrency = localEngramProvider.concurrency

  async initialize(config:any){
    return localEngramProvider.initialize?.(config)
  }
  async ingest(sessions:any, options:any){
    return localEngramProvider.ingest(sessions, options)
  }
  async awaitIndexing(result:any, containerTag:string, onProgress?:any){
    return localEngramProvider.awaitIndexing?.(result, containerTag, onProgress)
  }
  async search(query:string, options:any){
    return localEngramProvider.search(query, options)
  }
  async clear(containerTag:string){
    return localEngramProvider.clear?.(containerTag)
  }
}

export default LocalEngramProvider as any;
