// Runs in the page, including before its scripts on each new document. Preparation
// and snapshots use this exact recognition rule; no text-wide XHS fallback.
export function sourceTabState({ platform, kind, targetHandle }) {
  const visible = e => !!(e?.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const selected = e => e.getAttribute('aria-selected') === 'true' || e.getAttribute('data-state') === 'active' || /(^|\s)(active|selected)(\s|$)/.test(e.className);
  const expected = kind === 'saved' ? ['收藏'] : kind === 'liked' ? ['喜欢', '赞过', '点赞'] : platform === 'douyin' ? ['作品'] : ['笔记'];
  const legacy = '[role="tab"], .tabs-item, .tab-item, [data-state="active"]';
  const category = text => {
    const name = (text ?? '').trim().replace(/\s+/g, ' ');
    if (name === '收藏') return 'saved';
    if (name === '喜欢' || name === '赞过' || name === '点赞') return 'liked';
    const count = '\\d{1,8}(?:\\.\\d{1,2})?\\s*[万亿]?';
    return new RegExp(`^作品(?:\\s*(?:${count}|\\(\\s*${count}\\s*\\)|（\\s*${count}\\s*）))?$`).test(name) ? 'profile' : null;
  };
  const ownedTabs = group => [...group.querySelectorAll('[role="tab"]')].filter(e => e.closest('[role="tablist"]') === group);
  const sourceLike = group => new Set(ownedTabs(group).map(e => category(e.textContent)).filter(Boolean)).size >= 2;
  const sourceVisible = element => {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let e=element; e; e=e.parentElement) {
      const css=getComputedStyle(e);
      if(e.hidden || e.inert || e.getAttribute('aria-hidden')==='true' || css.display==='none' || ['hidden','collapse'].includes(css.visibility) || Number(css.opacity)===0)return false;
    }
    return true;
  };
  const inspectDouyin = groups => {
    const candidates=groups.filter(sourceLike), group=candidates.length===1?candidates[0]:null;
    const all=group?ownedTabs(group):[], entries=all.map(e=>({e,category:category(e.textContent)}));
    const known=entries.filter(x=>x.category);
    const counts=Object.fromEntries(['profile','saved','liked'].map(c=>[c,known.filter(x=>x.category===c).length]));
    const meaningful=groups.some(g=>ownedTabs(g).some(e=>category(e.textContent)));
    const valid=!!group && sourceVisible(group) && counts.profile===1 && counts.saved<=1 && counts.liked<=1 &&
      (kind==='profile' ? counts.saved+counts.liked>=1 : counts.saved===1 && counts.liked===1) &&
      known.every(({e,category:c})=>sourceVisible(e) && (!e.getAttribute('aria-label')?.trim() || category(e.getAttribute('aria-label'))===c)) &&
      all.every(e=>!e.hasAttribute('aria-selected') || ['true','false'].includes(e.getAttribute('aria-selected'))) &&
      all.filter(e=>e.getAttribute('aria-selected')==='true').length<=1;
    const target=valid?known.find(x=>x.category===kind)?.e:null;
    // Counts are display data, not source identity. Other tablists and feed
    // content never participate in this signature.
    const signature=`semantic:${candidates.length}:${valid}:${candidates.map(g=>`${sourceVisible(g)}:${ownedTabs(g).map(e=>`${category(e.textContent)??'?'}:${e.getAttribute('aria-selected')??'false'}:${sourceVisible(e)}:${category(e.getAttribute('aria-label'))??(e.getAttribute('aria-label')?.trim()?'invalid':'')}`).join('|')}`).join(';')}:${meaningful}`;
    return {target,selected:!!target && target.getAttribute('aria-selected')==='true',pending:!meaningful,meaningful,signature,semantic:true,groups:candidates,tabs:candidates.flatMap(ownedTabs)};
  };
  const inspect = () => {
    if(platform==='douyin') {
      const groups=[...document.querySelectorAll('[role="tablist"]')];
      if(groups.length)return inspectDouyin(groups);
    }
    const groups = platform === 'xiaohongshu' ? [...document.querySelectorAll('.xhs-user-page-primary-tabs')] : [];
    const modern = groups.length > 0;
    const group = groups.length === 1 && visible(groups[0]) ? groups[0] : null;
    const nodes = modern ? (group ? [...group.children].filter(e => e.matches('.reds-tab-item')) : []) : [...document.querySelectorAll(legacy)];
    const tabs = nodes.filter(visible), matches = tabs.filter(e => expected.includes(e.textContent.trim()));
    const active = tabs.filter(selected);
    const valid = (!modern || !!group) && matches.length === 1 && active.length <= 1;
    const target = valid ? matches[0] : null;
    return { target, selected: !!(target && selected(target)), pending: (!modern || !!group) && nodes.length === 0,
      signature: `${modern ? 'modern' : 'legacy'}:${groups.length}:${tabs.map(e => `${e.textContent.trim()}:${selected(e)}`).join('|')}`,
      meaningful: (modern && !group) || nodes.length > 0 };
  };
  const key = Symbol.for('UnifiedMediaHub.sourceObserver');
  let state = window[key];
  if (!state || state.platform !== platform || state.kind !== kind) {
    state?.observer.disconnect();
    const initial = inspect();
    state = { platform, kind, documentId: [...crypto.getRandomValues(new Uint32Array(4))].join('-'), generation: 0, signature: initial.signature, meaningful: initial.meaningful, observed:initial };
    const update = records => {
      const next = inspect();
      const prior=state.observed;
      const semantic=platform==='douyin' && (prior.semantic || next.semantic);
      const transientSource=semantic && (()=>{
        // Existing unrelated tablists may gain two source labels and restore
        // them in one batch. Inspect only changed label subtrees in memory;
        // never union labels from different moments or mutate the actual DOM.
        const established=new Set([...(prior.groups??[]),...(next.groups??[])]);
        const groups=new Set((records??[]).filter(r=>r.type==='characterData'||r.type==='childList')
          .map(r=>(r.target.nodeType===1?r.target:r.target.parentElement)?.closest?.('[role="tablist"]'))
          .filter(g=>g&&!established.has(g)));
        const owners=new WeakMap(), textValues=new WeakMap(), childValues=new WeakMap();
        const register=(node,owner)=>{owners.set(node,owner);for(const child of node.childNodes)register(child,owner);};
        for(const group of groups){const owner={tabs:ownedTabs(group)};for(const tab of owner.tabs)register(tab,owner);}
        const textAt=node=>node.nodeType===3?(textValues.has(node)?textValues.get(node):node.data):
          [...(childValues.get(node)??node.childNodes)].map(textAt).join('');
        for(const r of [...(records??[])].reverse()){
          const owner=owners.get(r.target);if(!owner)continue;
          if(r.type==='characterData')textValues.set(r.target,r.oldValue??'');
          else if(r.type==='childList'){
            const children=[...(childValues.get(r.target)??r.target.childNodes)];
            for(const added of r.addedNodes){const i=children.indexOf(added);if(i<0)return true;children.splice(i,1);}
            const index=r.nextSibling?children.indexOf(r.nextSibling):r.previousSibling?children.indexOf(r.previousSibling)+1:0;
            if(index<0||(r.previousSibling&&!children.includes(r.previousSibling)))return true;
            children.splice(index,0,...r.removedNodes);childValues.set(r.target,children);
            for(const removed of r.removedNodes)register(removed,owner);
          }else continue;
          if(new Set(owner.tabs.map(tab=>category(textAt(tab))).filter(Boolean)).size>=2)return true;
        }
        return false;
      })();
      const sourceChanged=semantic && records?.some(r=>{
        // Keep the previous identities: final DOM alone loses remove/restore,
        // role/name restoration and equal-markup replacement evidence.
        const groups=[...(prior.groups??[]),...(next.groups??[])];
        const tabs=[...(prior.tabs??[]),...(next.tabs??[])];
        const contains=(a,b)=>a===b || !!a.contains?.(b);
        const tab=tabs.find(e=>contains(e,r.target));
        // A text-only update from one valid works count to another is display
        // data. Element replacement and temporary invalid names still retire.
        if(tab && category(tab.textContent)==='profile') {
          const textWith=(node,target,text)=>node===target?text:node.nodeType===3?node.data:[...node.childNodes].map(n=>textWith(n,target,text)).join('');
          if(r.type==='characterData' && category(textWith(tab,r.target,r.oldValue))==='profile')return false;
          if(r.type==='childList' && r.removedNodes.length===1 && r.addedNodes.length===1 && [...r.removedNodes,...r.addedNodes].every(n=>n.nodeType===3) && r.target.childNodes.length===1 &&
            category(textWith(tab,r.target,r.removedNodes[0].textContent))==='profile' && category(textWith(tab,r.target,r.addedNodes[0].textContent))==='profile')return false;
        }
        if(r.type==='attributes') {
          if(!['role','aria-label','aria-selected','hidden','inert','aria-hidden','style','class'].includes(r.attributeName))return false;
          if(r.oldValue===r.target.getAttribute(r.attributeName))return false;
          if(r.attributeName==='aria-label' && category(r.target.textContent)==='profile' && category(r.oldValue)==='profile' && category(r.target.getAttribute('aria-label'))==='profile')return false;
          return [...groups,...tabs].some(e=>contains(r.target,e)) || tabs.some(e=>contains(e,r.target));
        }
        if(r.type==='characterData')return tabs.some(e=>contains(e,r.target));
        if(r.type!=='childList')return false;
        if(tabs.some(e=>contains(e,r.target)))return true;
        const changed=[...r.removedNodes,...r.addedNodes];
        if(changed.some(n=>[...groups,...tabs].some(e=>contains(n,e))))return true;
        // A temporary competing source group can be absent from both snapshots.
        if(changed.some(n=>[...(n.matches?.('[role="tablist"]')?[n]:[]),...(n.querySelectorAll?.('[role="tablist"]')??[])].some(sourceLike)))return true;
        return groups.includes(r.target) && changed.some(n=>n.matches?.('[role="tab"]') || n.querySelector?.('[role="tab"]'));
      });
      // Attribute changes can switch away and back within one mutation batch.
      const toggled = !semantic && records?.some(r => r.type === 'attributes' && ['class','aria-selected','data-state','style','hidden'].includes(r.attributeName) &&
        (r.target.matches?.(`${legacy}, .xhs-user-page-primary-tabs, .reds-tab-item`) || r.target.querySelector?.('.xhs-user-page-primary-tabs')) && r.oldValue !== r.target.getAttribute(r.attributeName));
      // A SPA may remove/replace tabs and restore the same final signature in
      // one batch. Removed nodes retain their subtree, so inspect the records,
      // including whole-group removals, rather than only the resulting DOM.
      const primary = '.xhs-user-page-primary-tabs';
      const replaced = platform === 'xiaohongshu' && records?.some(r => {
        if (r.type !== 'childList') return false;
        const changed = [...r.removedNodes, ...r.addedNodes];
        return r.target.closest?.(`${primary} > .reds-tab-item`) ||
          (r.target.matches?.(primary) && changed.some(n => n.matches?.('.reds-tab-item'))) ||
          changed.some(n => n.matches?.(primary) || n.querySelector?.(primary));
      });
      // Initial empty-shell hydration has no prior selection lease to retire.
      // Feed updates outside the primary structure do not affect this check.
      if (state.meaningful && (next.signature !== state.signature || transientSource || sourceChanged || toggled || replaced)) state.generation++;
      state.signature = next.signature; state.meaningful ||= next.meaningful;
      state.observed=next;
    };
    state.update = update;
    state.observer = new MutationObserver(update);
    state.observer.observe(document, {subtree:true,attributes:true,attributeOldValue:true,childList:true,characterData:true,characterDataOldValue:true});
    window[key] = state;
  }
  state.update(state.observer.takeRecords());
  const now = inspect();
  // Internal evaluateHandle mode shares the snapshot's exact recognition rule.
  // A stale document, route or generation must not acquire a different target.
  if(targetHandle!==undefined)return targetHandle && targetHandle.url===location.href &&
    targetHandle.documentId===state.documentId && targetHandle.tabGeneration===state.generation &&
    !now.selected ? now.target : null;
  return {url:location.href,documentId:state.documentId,tabGeneration:state.generation,selected:now.selected,pending:now.pending,label:now.target?.textContent.trim() ?? ''};
}

// The caller owns retirement. The child signal lets a timed-out gate close its
// identity page even if the outer scan itself has not been canceled.
export async function bounded(operation, signal, timeoutMs, code = 'observed_work_timeout') {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }),
      new Promise((_, reject) => {
        const stop = reason => { controller.abort(reason); reject(reason); };
        timer = setTimeout(() => stop(new Error(code)), timeoutMs);
        abort = () => stop(signal.reason ?? new Error('cancelled'));
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort',abort);
    controller.abort(new Error('operation_retired'));
  }
}

export const pause = (ms, signal) => bounded(() => new Promise(r => setTimeout(r,ms)),signal,ms+1000);
