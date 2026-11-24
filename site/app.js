(() => {
  'use strict';

  var OWNER = 'mikelgmh';
  var REPO = 'BunDeck';
  var RELEASE_PAGE = 'https://github.com/' + OWNER + '/' + REPO + '/releases/latest';
  var API_LATEST = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases/latest';

  function detectPlatform() {
    try {
      var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
      p = String(p).toLowerCase();
      if (p.indexOf('win') !== -1) return 'windows';
      if (p.indexOf('mac') !== -1) return 'macos';
      if (p.indexOf('linux') !== -1) return 'linux';
    } catch (e) { /* fall through */ }
    var ua = (navigator.userAgent || '').toLowerCase();
    if (ua.indexOf('windows') !== -1 || ua.indexOf('win64') !== -1 || ua.indexOf('win32') !== -1) return 'windows';
    if (ua.indexOf('macintosh') !== -1 || ua.indexOf('mac os') !== -1) return 'macos';
    if (ua.indexOf('linux') !== -1) return 'linux';
    return 'other';
  }

  function platformLabel(platform) {
    if (platform === 'windows') return 'Windows';
    if (platform === 'macos') return 'macOS';
    if (platform === 'linux') return 'Linux';
    return 'your platform';
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    var mb = bytes / (1024 * 1024);
    if (mb >= 1) return Math.round(mb) + ' MB';
    var kb = bytes / 1024;
    return Math.round(kb) + ' KB';
  }

  function pickAsset(assets, platform) {
    if (!assets || !assets.length) return null;
    var lower = function (n) { return (n || '').toLowerCase(); };
    if (platform === 'windows') {
      return assets.find(function (a) { return lower(a.name).indexOf('setup.exe') !== -1; })
        || assets.find(function (a) { return lower(a.name).indexOf('windows') !== -1 && lower(a.name).slice(-4) === '.exe'; })
        || assets.find(function (a) { return lower(a.name).slice(-4) === '.exe'; })
        || null;
    }
    if (platform === 'macos') {
      return assets.find(function (a) { return lower(a.name).indexOf('darwin') !== -1; })
        || assets.find(function (a) { return lower(a.name).indexOf('macos') !== -1; })
        || null;
    }
    if (platform === 'linux') {
      return assets.find(function (a) { return lower(a.name).indexOf('linux') !== -1; }) || null;
    }
    return null;
  }

  function setDownload(opts) {
    var btn = document.getElementById('download-button');
    var title = document.getElementById('download-title');
    var sub = document.getElementById('download-sub');
    var note = document.getElementById('release-note');
    if (!btn || !title || !sub) return;
    btn.href = opts.href;
    title.textContent = opts.title;
    sub.textContent = opts.sub;
    if (note && opts.note) note.textContent = opts.note;
  }

  function initDownloadButton() {
    var platform = detectPlatform();
    var fallbackTitle = platform === 'other' ? 'Get BunDeck' : 'Download for ' + platformLabel(platform);
    setDownload({ href: RELEASE_PAGE, title: fallbackTitle, sub: 'View available downloads' });

    fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) { if (!res.ok) throw new Error('github api ' + res.status); return res.json(); })
      .then(function (rel) {
        var tag = rel.tag_name || rel.name || '';
        var version = String(tag).replace(/^v/i, '');
        var assets = rel.assets || [];
        var asset = pickAsset(assets, platform);
        var size = asset ? formatSize(asset.size) : '';
        var note = version ? 'Latest release v' + version + '.' : 'Latest release.';

        if (asset && asset.browser_download_url) {
          var kind = platform === 'windows' ? 'Installer' : 'ZIP';
          var sub = size ? (kind + ' · ' + size) : kind;
          var title = platform === 'other' ? ('Get BunDeck v' + version) : ('Download for ' + platformLabel(platform));
          setDownload({ href: asset.browser_download_url, title: title, sub: sub, note: note });
        } else {
          setDownload({
            href: RELEASE_PAGE,
            title: platform === 'other' ? 'Get BunDeck' : ('Get BunDeck for ' + platformLabel(platform)),
            sub: 'View available downloads',
            note: note
          });
        }
      })
      .catch(function () {
        // Sin API (offline / rate-limit): el botón lleva a la página de releases.
        var btn = document.getElementById('download-button');
        if (btn) btn.href = RELEASE_PAGE;
        var note = document.getElementById('release-note');
        if (note && /checking/.test(note.textContent)) note.textContent = 'Latest release.';
      });
  }

  // ---- Mascota: mirada + parpadeo + salto (port de page.tsx, sin React) ----
 	var MOUTHS = { calm: 'M28 42c2 3 6 3 8 0', happy: 'M27 41c2 5 8 5 10 0', joy: 'M25 40c2 8 12 8 14 0' };

  function initMascot() {
    var mascot = document.getElementById('mascot');
    if (!mascot) return;
    var tilt = mascot.querySelector('[data-tilt]');
    var face = mascot.querySelector('[data-face]');
    var leftEye = mascot.querySelector('[data-eye="left"]');
    var rightEye = mascot.querySelector('[data-eye="right"]');
    var mouth = document.getElementById('mascot-mouth');
    var hop = document.getElementById('mascot-hop');
    if (!tilt || !face || !leftEye || !rightEye || !mouth || !hop) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var expression = 'calm';
    var hovered = false;
    var jumpTimer = null;
    var target = { x: 0, y: 0 };
    var current = { x: 0, y: 0 };
    var lastMove = performance.now();
    var frameId = 0;
    var blinkTimer = 0;
    var blinkReset = 0;

    function setExpression(next) {
      expression = next;
      mascot.classList.toggle('is-happy', next === 'happy');
      mascot.classList.toggle('is-joy', next === 'joy');
      mouth.setAttribute('d', MOUTHS[next] || MOUTHS.calm);
    }

    function aim(x, y) {
      var rect = mascot.getBoundingClientRect();
      var dx = x - (rect.left + rect.width / 2);
      var dy = y - (rect.top + rect.height * 0.58);
      var distance = Math.hypot(dx, dy) || 1;
      var amount = Math.min(1, distance / (rect.width * 0.9));
      target.x = (dx / distance) * amount;
      target.y = (dy / distance) * amount;
    }

    function onPointerMove(e) {
      lastMove = performance.now();
      aim(e.clientX, e.clientY);
    }
    function resetAim() { target.x = 0; target.y = 0; }

    function animateEyes() {
      current.x += (target.x - current.x) * 0.14;
      current.y += (target.y - current.y) * 0.14;
      leftEye.setAttribute('transform', 'translate(' + (current.x * 2.3) + ' ' + (current.y * 1.8) + ')');
      rightEye.setAttribute('transform', 'translate(' + (current.x * 2.3) + ' ' + (current.y * 1.8) + ')');
      face.setAttribute('transform', 'translate(' + (current.x * 3.2) + ' ' + (current.y * 2.2) + ')');
      tilt.setAttribute('transform', 'rotate(' + (current.x * 4) + ' 32 54)');
      frameId = requestAnimationFrame(animateEyes);
    }

    function blinkAtRandomIntervals() {
      blinkTimer = window.setTimeout(function () {
        mascot.classList.add('is-blinking');
        blinkReset = window.setTimeout(function () { mascot.classList.remove('is-blinking'); }, 200);
        blinkAtRandomIntervals();
      }, 2200 + Math.random() * 3200);
    }

    var idleLook = window.setInterval(function () {
      if (performance.now() - lastMove > 3500) {
        target.x = Math.random() * 1.8 - 0.9;
        target.y = Math.random() - 0.5;
      }
    }, 1600);

    function jump() {
      hop.classList.remove('jump');
      void hop.getBoundingClientRect();
      hop.classList.add('jump');
      setExpression('joy');
      if (jumpTimer) window.clearTimeout(jumpTimer);
      jumpTimer = window.setTimeout(function () {
        hop.classList.remove('jump');
        setExpression(hovered ? 'happy' : 'calm');
      }, 900);
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', resetAim);
    mascot.addEventListener('pointerenter', function () { hovered = true; if (expression !== 'joy') setExpression('happy'); });
    mascot.addEventListener('pointerleave', function () { hovered = false; if (expression !== 'joy') setExpression('calm'); });
    mascot.addEventListener('click', jump);
    mascot.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); jump(); }
    });

    frameId = requestAnimationFrame(animateEyes);
    blinkAtRandomIntervals();

    window.addEventListener('pagehide', function () {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', resetAim);
      window.clearInterval(idleLook);
      cancelAnimationFrame(frameId);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkReset);
      if (jumpTimer) window.clearTimeout(jumpTimer);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initDownloadButton(); initMascot(); });
  } else {
    initDownloadButton();
    initMascot();
  }
})();
