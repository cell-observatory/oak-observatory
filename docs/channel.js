// The site's channel menu. The stable site (built from main) is published at the site root and the pre-release site
// (built from dev, for people on the dev channel) under dev/. The Pages workflow writes versions.json at the root,
// {"stable": "X.Y.Z", "dev": "X.Y.Z-dev.N"}; with it, the version label in the top bar becomes a menu that opens the
// same page on the other channel. Without it (a local preview, or a deploy with no pre-release site) the label stays
// a plain label.
(function () {
  // Where a page sits: on which channel, the stable site's root, and the page's file name.
  function channelTargets(pathname) {
    var m = /^(.*\/)dev\/([^\/]*)$/.exec(pathname);
    var root = m ? m[1] : pathname.replace(/[^\/]*$/, '');
    var page = (m ? m[2] : pathname.slice(root.length)) || 'showcase.html';
    return { channel: m ? 'dev' : 'stable', root: root, page: page, stable: root + page, dev: root + 'dev/' + page };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { channelTargets: channelTargets }; return; }

  var label = document.querySelector('header [data-co-version]');
  if (!label || !window.fetch) return;
  var at = channelTargets(location.pathname);
  fetch(at.root + 'versions.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) { if (v && typeof v.stable === 'string' && typeof v.dev === 'string') build(v); })
    .catch(function () {});

  function build(v) {
    var style = document.createElement('style');
    style.textContent =
      '.oak-chan{position:relative;display:inline-flex;align-items:center}' +
      '.oak-chan-btn{font:500 10.5px/1 var(--font-mono,var(--mono,monospace));letter-spacing:0;color:var(--faint,var(--ink-faint));' +
      'background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 6px;cursor:pointer}' +
      '.oak-chan-btn:hover,.oak-chan-btn[aria-expanded="true"]{color:var(--ink);border-color:var(--border,var(--line))}' +
      '.oak-chan-btn.pre{color:var(--accent-ink);border-color:var(--accent-soft)}' +
      '.oak-chan-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:70;min-width:250px;padding:6px;' +
      'background:var(--panel,var(--bg));border:1px solid var(--border,var(--line));border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18)}' +
      '.oak-chan-menu[hidden]{display:none}' +
      '.oak-chan-menu a{display:block;padding:8px 10px;border-radius:7px;color:var(--ink);text-decoration:none;font-size:13px;line-height:1.35}' +
      '.oak-chan-menu a:hover,.oak-chan-menu a:focus{background:var(--accent-soft);outline:none}' +
      '.oak-chan-menu a[aria-current] b::after{content:" \\2713";color:var(--accent)}' +
      '.oak-chan-menu code{font-family:var(--font-mono,var(--mono,monospace));font-size:11.5px;color:var(--faint,var(--ink-faint))}' +
      '.oak-chan-menu small{display:block;margin-top:2px;font-size:11.5px;color:var(--faint,var(--ink-faint))}';
    document.head.appendChild(style);

    var wrap = document.createElement('span');
    wrap.className = 'oak-chan';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oak-chan-btn' + (at.channel === 'dev' ? ' pre' : '');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Switch between the stable and the pre-release site';
    btn.textContent = 'v' + v[at.channel] + (at.channel === 'dev' ? ' · pre-release' : '') + ' ▾';
    var menu = document.createElement('div');
    menu.className = 'oak-chan-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    [['stable', 'Stable', 'Tagged releases'], ['dev', 'Pre-release', 'The dev channel: the newest build, with less testing']].forEach(function (c) {
      var a = document.createElement('a');
      a.setAttribute('role', 'menuitem');
      a.href = at[c[0]];
      if (c[0] === at.channel) a.setAttribute('aria-current', 'page');
      var b = document.createElement('b'); b.textContent = c[1];
      var code = document.createElement('code'); code.textContent = 'v' + v[c[0]];
      var small = document.createElement('small'); small.textContent = c[2];
      a.appendChild(b); a.appendChild(document.createTextNode(' ')); a.appendChild(code); a.appendChild(small);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        if (c[0] === at.channel) { close(); return; }
        // A page the other channel does not have yet (or no longer has) opens that channel's home page.
        var home = c[0] === 'dev' ? at.root + 'dev/' : at.root;
        fetch(a.href, { method: 'HEAD' })
          .then(function (r) { location.href = r.ok ? a.href : home; })
          .catch(function () { location.href = a.href; });
      });
      menu.appendChild(a);
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    label.style.display = 'none';
    (label.closest('a') || label).insertAdjacentElement('afterend', wrap);

    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function () { if (menu.hidden) { open(); menu.querySelector('a').focus(); } else close(); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) {
      if (menu.hidden) return;
      var items = [].slice.call(menu.querySelectorAll('a'));
      var i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
  }
})();
