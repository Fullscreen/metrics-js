'use strict';Object.defineProperty(exports,'__esModule',{value:!0}),exports.default={memory:window.performance&&window.performance.memory&&window.performance.memory.totalJSHeapSize,performanceTimeline:window.performance&&window.performance.getEntriesByType,mark:window.performance&&window.performance.mark,measure:window.performance&&window.performance.measure,timing:window.performance&&window.performance.timing,clearResourceTimings:window.performance&&window.performance.clearResourceTimings,navigationTiming:window.performance&&window.performance.timing&&'undefined'!=typeof window.performance.timing.navigationStart,PerformanceObserver:window.PerformanceObserver,PerformanceSetBuffer:window.performance&&window.performance.setResourceTimingBufferSize};
//# sourceMappingURL=feature-detection-service.js.map