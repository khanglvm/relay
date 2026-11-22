  // ---------- video (YouTube/Vimeo embed, local stream, or direct URL) ----------
  function renderVideo(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-videowrap' });
    let media;
    if (block.provider === 'youtube') {
      const q = block.start ? '?start=' + block.start : '';
      media = el('iframe', {
        class: 'blk-video-embed',
        src: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(block.videoId) + q,
        title: block.title || 'YouTube video',
        frameborder: '0',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
        referrerpolicy: 'strict-origin-when-cross-origin',
        allowfullscreen: 'true',
        loading: 'lazy',
      });
    } else if (block.provider === 'vimeo') {
      media = el('iframe', {
        class: 'blk-video-embed',
        src: 'https://player.vimeo.com/video/' + encodeURIComponent(block.videoId),
        title: block.title || 'Vimeo video',
        frameborder: '0',
        allow: 'autoplay; fullscreen; picture-in-picture',
        allowfullscreen: 'true',
        loading: 'lazy',
      });
    } else {
      // local file (served via /video/b/<id>) or a direct http(s) media URL
      const src = block.hasFile ? '/video/b/' + encodeURIComponent(blockId) : block.src;
      media = el('video', { class: 'blk-video', controls: 'true', preload: 'metadata', playsinline: 'true' });
      if (block.title) media.setAttribute('title', block.title);
      const source = el('source', { src });
      if (block.mime) source.setAttribute('type', block.mime);
      media.append(source);
      media.append(document.createTextNode('Your browser cannot play this video.'));
    }
    wrap.append(media);
    if (block.title) wrap.append(el('div', { class: 'blk-videocap' }, block.title));
    // whole-block comment + the comment pin (no zoom/full-screen for media)
    attachViewer(wrap, { zoomEl: null, label: 'video', comment: wholeBlockComment(ctx, blockId, 'video') });
    return wrap;
  }

