// Invented identifiers, labels and media URLs. Never use a captured account/page.
export const work='1234509876543210001';
export function ssrDetail({live=false,count=9,id=work}={}){
 return {awemeId:id,awemeType:68,mediaType:live?42:2,isSlides:true,desc:'Synthetic photo fixture',createTime:1700000000,authorInfo:{nickname:'Synthetic Author',secUid:'synthetic-author'},images:Array.from({length:count},(_,i)=>({width:1080,height:1440,uri:`synthetic-${i+1}`,urlList:[`https://p3.douyinpic.com/synthetic-${i+1}.jpg`,`https://p9.douyinpic.com/synthetic-${i+1}.jpg`],downloadUrlList:[],video:live?{playApi:`https://www.douyin.com/synthetic-play/${i+1}`,playAddr:[{src:`https://v1.zjcdn.com/synthetic-${i+1}.mp4`}]}:'$undefined',clipType:live?5:'$undefined',livePhotoType:live?1:0}))};
}
export function wrapper(detail,id=detail.awemeId){return {awemeId:id,aweme:{statusCode:0,detail},comment:{},statusCode:0,logPb:{},accountInfo:{},redirect:null,seoRelatedModuleList:[],defaultSeoRelatedAweme:null,isSpider:false,isFromSEO:false};}
export function rscScript(detail,{depth=12,prefix='7'}={}){
 let root=wrapper(detail);for(let i=0;i<depth;i++)root=['$','$L9',null,{children:root}];
 return `self.__pace_f.push(${JSON.stringify([1,prefix+':'+JSON.stringify(root)])});`;
}
export function rscHtml(detail,{total=190,index=187,...options}={}){
 return '<!doctype html><body>'+Array.from({length:total},(_,i)=>`<script>${i===index?rscScript(detail,options):i===0?'self.__pace_f=[];':'void 0;'}</script>`).join('');
}
