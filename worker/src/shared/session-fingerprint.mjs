import {createHash} from 'node:crypto';

// Identity continuity only: ephemeral, never emitted, logged or persisted.
// Confirm cookie names passively during stage B; never record their values.
export const SESSION_COOKIES={douyin:['sessionid','sessionid_ss','uid_tt','sid_tt'],xiaohongshu:['web_session']};
export async function sessionFingerprint(context,platform){
 const names=SESSION_COOKIES[platform]??[];
 const cookies=(await context.cookies()).filter(c=>names.includes(c.name)).sort((a,b)=>a.name.localeCompare(b.name)||a.value.localeCompare(b.value));
 return cookies.length?createHash('sha256').update(cookies.map(c=>`${c.name}=${c.value}\n`).join('')).digest('hex'):null;
}
