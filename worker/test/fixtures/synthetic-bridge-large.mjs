// Invented IDs/URLs only. Long URLs exercise event bounds, no captured tokens.
export function largeBridgeWork(id='1234509876543210001'){
 const value={awemeId:id,desc:'Synthetic 93 images +72 live videos',authorInfo:{secUid:'synthetic-author',nickname:'Synthetic'},images:Array.from({length:93},(_,i)=>({urlList:['https://p3.douyinpic.com/synthetic-'+i+'-'+'x'.repeat(650)+'.webp'],...(i<72?{video:{playAddr:['https://v1.zjcdn.com/synthetic-'+i+'-'+'y'.repeat(650)+'.mp4']}}:{})})),video:{cover:{urlList:['https://p3.douyinpic.com/synthetic-cover.webp']}}};
 value.unused={padding:'x'.repeat(505*1024-Buffer.byteLength(JSON.stringify(value))-30)};return value;
}
