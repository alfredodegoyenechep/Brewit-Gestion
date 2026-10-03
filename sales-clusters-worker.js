const { parentPort, workerData } = require('node:worker_threads');
const { runAnalysis, compareWithModel, recommendRefinements } = require('./sales-clusters');

try {
  const progress = update => parentPort.postMessage({ type: 'progress', update });
  const output = workerData.mode === 'comparison' ? compareWithModel(workerData.input, workerData.reference, progress) :
    workerData.mode === 'refinements' ? recommendRefinements(workerData.input, progress) : runAnalysis(workerData.input, progress);
  parentPort.postMessage({ type: 'complete', output });
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: error.message });
}
