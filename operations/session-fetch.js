// Historical forms share the authenticated cookie and CSRF contract while their
// per-location authorization is migrated. No token is sent to another origin.
(() => {
  const original=window.fetch.bind(window);
  const session=original('/api/v1/operations/status').then(r=>r.json()).then(status=>status.configured
    ? original('/api/v1/operations/session').then(r=>r.ok?r.json():null):null).catch(()=>null);
  window.fetch=async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:input,location.href);
    const internal=url.origin===location.origin && (url.pathname.startsWith('/api/') || url.pathname==='/upload/master');
    const method=String(init.method || (input instanceof Request?input.method:'GET')).toUpperCase();
    if(internal && !['GET','HEAD','OPTIONS'].includes(method)){
      const current=await session;
      if(current?.csrf){const headers=new Headers(init.headers || (input instanceof Request?input.headers:undefined));headers.set('X-CSRF-Token',current.csrf);init={...init,headers};}
    }
    const response=await original(input,init);
    if(internal && response.status===401 && !url.pathname.startsWith('/api/v1/operations/'))location.assign('/operaciones');
    return response;
  };
})();
