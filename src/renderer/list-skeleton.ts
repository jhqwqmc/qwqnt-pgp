export const listSkeletonCss = `
  .qwqnt-pgp-skeleton { display:flex; align-items:center; gap:8px; box-sizing:border-box; height:var(--pgp-row-height,36px); padding:0 8px; border-bottom:1px solid var(--border_level_1,rgba(127,127,127,.12)); }
  .qwqnt-pgp-skeleton:last-child { border-bottom:0; }
  .qwqnt-pgp-skeleton > span { height:10px; border-radius:5px; background:linear-gradient(100deg, transparent 25%, rgba(127,127,127,.18) 50%, transparent 75%) 100% 0 / 250% 100%, rgba(127,127,127,.13); animation:qwqnt-pgp-skeleton-sweep 1.4s linear infinite; }
  .qwqnt-pgp-skeleton > .avatar { width:18px; height:18px; border-radius:50%; }
  .qwqnt-pgp-skeleton > .name { width:38%; margin-inline-end:auto; }
  .qwqnt-pgp-skeleton > .detail { width:20%; max-width:80px; }
  .qwqnt-pgp-skeleton > .control { width:16px; height:16px; border-radius:50%; }
  @keyframes qwqnt-pgp-skeleton-sweep { to { background-position:-65% 0; } }
  @media (prefers-reduced-motion:reduce) { .qwqnt-pgp-skeleton > span { animation:none; } }
`;

export function listSkeleton(rows: number, avatar = false, switchControl = false): string {
  return `<div class="qwqnt-pgp-skeleton" aria-hidden="true">
    ${avatar ? '<span class="avatar"></span>' : ''}
    <span class="name"></span><span class="detail"></span>
    <span class="control"${switchControl ? ' style="width:28px;height:12px"' : ''}></span>
  </div>`.repeat(rows);
}
