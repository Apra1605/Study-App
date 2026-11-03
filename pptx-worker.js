import { inspectPptx, extractPptxBatch } from './pptx-parser.js?v=20261101-1';

let buffer = null;
let inspection = null;
let nextIndex = 0;
let batchSize = 10;
let busy = false;

self.onmessage = async event => {
  const message = event.data || {};
  try {
    if (message.type === 'start') {
      buffer = message.source;
      nextIndex = Math.max(0, Number(message.startIndex) || 0);
      batchSize = Math.max(1, Math.min(20, Number(message.batchSize) || 10));
      inspection = await inspectPptx(buffer);
      if (nextIndex > inspection.slideEntries.length) nextIndex = 0;
      self.postMessage({ type: 'ready', totalSlides: inspection.slideEntries.length, nextIndex });
      return;
    }
    if (message.type !== 'continue' || busy || !inspection) return;
    busy = true;
    const result = await extractPptxBatch(buffer, inspection, nextIndex, batchSize);
    nextIndex = result.nextIndex;
    busy = false;
    self.postMessage({ type: nextIndex >= result.totalSlides ? 'finished' : 'batch', ...result });
  } catch (error) {
    busy = false;
    self.postMessage({ type: 'error', message: error?.message || 'Could not process this presentation.' });
  }
};
