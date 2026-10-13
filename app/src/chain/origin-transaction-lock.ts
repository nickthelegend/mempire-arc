/** Origin-wide exclusion; never substitute non-atomic storage or a timer lease. */
export async function withOriginTransactionLock<T>(identity:string,run:()=>Promise<T>):Promise<T>{
 const locks=globalThis.navigator?.locks;
 if(!locks||globalThis.isSecureContext===false)throw Error('Secure browser transaction locking is unavailable. New submissions and recovery are blocked. Use a supported secure browser.');
 return locks.request(`arc:transaction-lock:${identity}`,{mode:'exclusive',ifAvailable:true},async lock=>{
  if(!lock)throw Error('This wallet transaction is active in another tab. Finish or check the original transaction there.');
  return run();
 });
}
