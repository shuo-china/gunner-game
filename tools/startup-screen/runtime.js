/* Shared by the browser cover, WeChat engine boot and Cocos startup view.
 * The artwork is a local JPEG; all text uses installed system fonts. */
(function (scope) {
  'use strict';
  const theme = {
    background: 'startup-background.jpg', image: null, imagePromise: null, generation: 0,
    progress: 0, browserCover: null,
    canvas() { return typeof wx !== 'undefined' && wx.createCanvas ? wx.createCanvas() : document.createElement('canvas'); },
    load() {
      if (this.imagePromise) return this.imagePromise;
      const generation = this.generation;
      this.imagePromise = new Promise(resolve => {
        const image = typeof wx !== 'undefined' && wx.createImage ? wx.createImage() : new Image();
        image.onload = () => { if (generation === this.generation) this.image = image; resolve(image); };
        // The decorative image must never prevent the game from starting.
        image.onerror = () => resolve(null);
        image.src = this.background;
      });
      return this.imagePromise;
    },
    setProgress(value) {
      if (Number.isFinite(value)) this.progress = Math.max(this.progress, Math.min(1, Math.max(0, value)));
      return this.progress;
    },
    release() { this.generation++; this.image = null; this.imagePromise = null; this.progress = 0; },
    layout(width, height) {
      return { top: Math.floor(height * .79), height: Math.ceil(height * .17),
        versionY: height * .937, labelY: height * .817, barY: height * .853, percentY: height * .817,
        statusY: height * .888, hintY: height * .914, barW: width * .756, barH: width * .027,
        labelSize: width * .035, percentSize: width * .038, detailSize: width * .027 };
    },
    statusLines(status, error) {
      const lines = String(status).split('\n').map(line => line.trim()).filter(Boolean);
      const version = lines.find(line => /^版本\s/.test(line)) ||
        '版本 ' + (typeof scope.__FOREST_GUNNER_RELEASE__ === 'string' ? scope.__FOREST_GUNNER_RELEASE__ : 'local');
      const details = lines.filter(line => !/^版本\s/.test(line) && !/^点击.*重试/.test(line));
      let line;
      if (error) {
        // Prefer the failing resource and cause over the generic module heading.
        line = details.slice(1).join(' ') || details[0] || '请重新进入游戏';
        if (!/失败/.test(line)) line = '加载失败：' + line;
        if (lines.some(item => /点击.*重试/.test(item))) line += ' · 点击重试';
      } else {
        line = details.find(item => /^(正在加载|预下载|资源失败)：/.test(item)) || details[0] || '正在加载引擎与启动场景…';
      }
      return { version, line };
    },
    fitLine(ctx, text, maxWidth) {
      if (ctx.measureText(text).width <= maxWidth) return text;
      const chars = Array.from(text);
      // Keep both the resource prefix and the filename/error at the end.
      let keep = chars.length - 1;
      while (keep > 1) {
        const head = Math.ceil(keep * .4), tail = keep - head;
        const short = chars.slice(0, head).join('') + '…' + chars.slice(-tail).join('');
        if (ctx.measureText(short).width <= maxWidth) return short;
        keep--;
      }
      return '…';
    },
    round(ctx, x, y, width, height, radius, color) {
      if (width <= 0 || height <= 0) return;
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r); ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height); ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r); ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    },
    overlay(ctx, width, height, value, error, offset = 0, status = '') {
      const l = this.layout(width, height), x = (width - l.barW) / 2, y = l.barY - l.barH / 2 - offset;
      // The illustration leaves a quiet path here. Keep the live UI light and
      // the expensive uploaded strip small; do not cover the scene with a card.
      const inset = width * .0035, innerW = l.barW - inset * 2, innerH = l.barH - inset * 2;
      this.round(ctx, x - inset, y - inset, l.barW + inset * 2, l.barH + inset * 2, l.barH / 2, '#fff8df');
      this.round(ctx, x, y, l.barW, l.barH, l.barH / 2, '#786044');
      this.round(ctx, x + inset, y + inset, innerW, innerH, innerH / 2, '#e9d4a5');
      this.round(ctx, x + inset, y + inset,
        innerW * Math.max(0, Math.min(1, value)), innerH, innerH / 2, error ? '#b65b42' : '#6f8e48');
      ctx.fillStyle = error ? '#973f2d' : '#563f29'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const text = this.statusLines(status, error);
      ctx.font = 'bold ' + Math.round(l.labelSize) + 'px "Microsoft YaHei", sans-serif';
      const heading = error ? '整装稍候，点击重试' : value >= 1 ? '准备就绪，即刻出征' : '小队集结中…';
      ctx.lineWidth = width * .006; ctx.strokeStyle = '#fff3d3'; ctx.lineJoin = 'round';
      ctx.strokeText(heading, x, l.labelY - offset);
      ctx.fillText(heading, x, l.labelY - offset);
      ctx.textAlign = 'right';
      ctx.font = 'bold ' + Math.round(l.percentSize) + 'px "Microsoft YaHei", sans-serif';
      ctx.fillText(Math.floor(value * 100) + '%', x + l.barW, l.percentY - offset);
      ctx.textAlign = 'center';
      ctx.fillStyle = error ? '#973f2d' : '#69513a';
      ctx.font = Math.round(l.detailSize) + 'px "Microsoft YaHei", sans-serif';
      ctx.fillText(this.fitLine(ctx, text.line, l.barW), width / 2, l.statusY - offset, l.barW);
      if (!error && value < 1) {
        ctx.fillText('首次加载会慢一点，小队正背着行囊赶来啦～', width / 2, l.hintY - offset, l.barW);
      }
      ctx.fillStyle = '#7b6247';
      ctx.font = Math.round(l.detailSize * .9) + 'px "Microsoft YaHei", sans-serif';
      ctx.fillText(this.fitLine(ctx, text.version, l.barW), width / 2, l.versionY - offset, l.barW);
    },
    render(target, value = this.progress, error = false) {
      const ctx = target.getContext('2d'), w = target.width, h = target.height;
      ctx.fillStyle = '#fae9bf'; ctx.fillRect(0, 0, w, h);
      if (this.image) {
        const scale = Math.max(w / this.image.width, h / this.image.height);
        const dw = this.image.width * scale, dh = this.image.height * scale;
        ctx.drawImage(this.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
      this.overlay(ctx, w, h, value, error);
    },
    hideBrowserCover() {
      if (!this.browserCover) return;
      this.browserCover.remove(); this.browserCover = null;
      if (this.browserResize) scope.removeEventListener('resize', this.browserResize);
      this.browserResize = null;
    },
    mountBrowser() {
      if (typeof document === 'undefined' || typeof wx !== 'undefined') return;
      const canvas = this.browserCover = document.createElement('canvas');
      canvas.id = 'startup-cover';
      canvas.setAttribute('aria-label', '小队出征，正在加载');
      canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;pointer-events:none;';
      document.body.appendChild(canvas);
      const paint = this.browserResize = () => {
        if (!this.browserCover) return;
        // Enough resolution for a phone, without a full device-DPR buffer.
        const ratio = Math.min(2, scope.devicePixelRatio || 1);
        canvas.width = Math.round(scope.innerWidth * ratio); canvas.height = Math.round(scope.innerHeight * ratio);
        this.render(canvas);
      };
      scope.addEventListener('resize', paint); paint(); this.load().then(paint);
    }
  };
  scope.__FOREST_STARTUP_VISUALS__ = theme;
  if (typeof module !== 'undefined' && module.exports) module.exports = theme;
})(typeof globalThis !== 'undefined' ? globalThis : GameGlobal);
