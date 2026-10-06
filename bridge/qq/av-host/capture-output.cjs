// SPDX-License-Identifier: GPL-3.0-only
'use strict';
(() => {
  let stream = null, starting = false, ended = false;
  const video = document.querySelector('video');
  window.rtcCaptureStop = () => { ended = true; stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; };
  window.rtcCaptureAlive = () => !!stream?.active && !ended && stream.getVideoTracks().some(track => track.readyState === 'live');
  window.rtcCaptureStart = async () => {
    if (starting || stream) throw new Error('Capture already active'); starting = true; ended = false;
    try {
      // The private Electron session grants precisely one enumerated source.
      const pending = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 15, max: 30 } } });
      if (ended) { pending.getTracks().forEach(track => track.stop()); throw new Error('Capture cancelled'); }
      stream = pending;
      const tracks = stream.getVideoTracks();
      if (tracks.length !== 1 || stream.getAudioTracks().length) throw new Error('Unexpected capture tracks');
      tracks[0].addEventListener('ended', () => { ended = true; });
      video.srcObject = stream; await video.play();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The selected source produced no frame')), 8000);
        video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
      });
      if (!window.rtcCaptureAlive()) throw new Error('Capture ended before its first frame');
      return { width: video.videoWidth, height: video.videoHeight };
    } catch (error) { window.rtcCaptureStop(); throw error; }
    finally { starting = false; }
  };
  window.addEventListener('beforeunload', window.rtcCaptureStop);
})();
