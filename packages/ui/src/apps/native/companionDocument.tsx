import type { Theme } from '@/types/theme';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { iconSpriteData } from '@/components/icon/sprite';
const icons = ['list-unordered', 'git-branch', 'file-text', 'notification-3', 'refresh', 'plug-2', 'donut-chart', 'arrow-right-s', 'arrow-down-s'] as const;
export type CompanionFrame = { scope: number; workspaceScope: number; document: string; html: string; background: string };
const themeGenerator = new CSSVariableGenerator();
const escapeStyle = (text: string) => text.replace(/<\/style/gi, '<\\/style');
/** Markup comes only from the committed CompanionSurface DOM, never raw host HTML. */
export const companionFrame = (markup: string, theme: Theme, scope: number, owner: number, stylesheets: string[]): CompanionFrame => {
  const html = `<style>${escapeStyle(`:root{${themeGenerator.generate(theme)}}`)}</style>${markup}`;
  const sprite = `<svg aria-hidden="true" style="display:none">${icons.map((name) => `<symbol id="oc-${name}" viewBox="0 0 24 24">${iconSpriteData[name]}</symbol>`).join('')}</svg>`;
  const links = stylesheets.filter((url) => { try { const parsed = new URL(url); return parsed.origin === 'https://localhost' && parsed.pathname.startsWith('/assets/') && parsed.pathname.endsWith('.css'); } catch { return false; } }).map((url) => `<link rel="stylesheet" href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`).join('');
  // Fixed script only. User strings appear only as escaped React text or validated raster data URLs.
  const script = `
let scope=-1,owner=-1,positions={},presentation={files:false,wrap:true};
const applyPresentation=()=>{
  const root=document.querySelector('.oc-companion');if(!root)return;
  root.dataset.filesHidden=String(presentation.files);root.dataset.codeWrap=String(presentation.wrap);
  const files=root.querySelector('[data-cpresentation="files"]');
  if(files){files.setAttribute('aria-expanded',String(!presentation.files));files.setAttribute('aria-label',presentation.files?'Show file list':'Hide file list')}
  const wrap=root.querySelector('[data-cpresentation="wrap"]');
  if(wrap)wrap.setAttribute('aria-pressed',String(presentation.wrap));
};
window.companionRender=(html,nextScope,nextOwner,saved)=>{
  if(owner!==nextOwner){positions={};owner=nextOwner}
  for(const el of document.querySelectorAll('[data-scroll]'))positions[el.dataset.scroll]=[el.scrollLeft,el.scrollTop];
  if(saved)positions={...saved,...positions};
  document.getElementById('companion-root').innerHTML=html;scope=nextScope;applyPresentation();
  for(const el of document.querySelectorAll('[data-scroll]')){const p=positions[el.dataset.scroll];if(p){el.scrollLeft=p[0];el.scrollTop=p[1]}}
};
document.addEventListener('click',e=>{
  const local=e.target.closest('[data-cpresentation]');
  if(local){const key=local.dataset.cpresentation;if(key==='files'||key==='wrap'){presentation[key]=!presentation[key];applyPresentation()}return}
  const b=e.target.closest('[data-caction]');if(!b||b.disabled)return;
  window.CompanionActions.post(JSON.stringify({scope,type:b.dataset.caction,index:b.dataset.index===undefined?undefined:Number(b.dataset.index),choice:b.dataset.choice===undefined?undefined:Number(b.dataset.choice),tab:b.dataset.tab}));
});
let scrollTimer;
document.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{for(const el of document.querySelectorAll('[data-scroll]'))positions[el.dataset.scroll]=[el.scrollLeft,el.scrollTop];window.CompanionActions.scroll(JSON.stringify(positions))},100)},true);
`;
  const document = `<!doctype html><html class="oc-companion-document ${theme.metadata.variant}" data-theme-id="${theme.metadata.id.replace(/[^a-zA-Z0-9_-]/g, '')}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline' https://localhost;font-src https://localhost data:;img-src data:;script-src 'nonce-companion-shell';connect-src 'none';frame-src 'none';base-uri 'none';form-action 'none'">${links}</head><body>${sprite}<div id="companion-root"></div><script nonce="companion-shell">${script}</script></body></html>`;
  return { scope, workspaceScope: owner, document, html, background: theme.colors.surface.background };
};
