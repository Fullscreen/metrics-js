/* eslint-disable no-return-assign */
import protobuf from 'protobufjs/dist/light/protobuf.min'
import jsonProtobufDescriptor from './metrics.json'
import featureAvailable from './feature-detection-service.js'

function invertObjectKV (json) {
  const flipped = {}
  for (let k in json) {
    flipped[json[k]] = k
  }
  return flipped
}

// metric is the name of the range, the key is the end marker
// from is the start of the range
// an end marker can have more than one metric/start
// const TIMING_RANGES = {
  // 'page.digested': [
    // {
      // from: 'page.resolved',
      // metric: 'ui.digested'
    // },
    // {
      // from: 'navigationStart',
      // metric: 'ui.timeToFirstDigest',
      // once: true
    // }
  // ]
// }

function isDefined (value) {
  return typeof value !== 'undefined'
}

let metricsMessage = protobuf.Root.fromJSON(jsonProtobufDescriptor).lookupType('fsMetrics.fsMetricsMessage')

// pass in global tags
// pass in normalization tags
// pass in ignored urls
// pass in whiteList of resources

export default class FsMetrics {
  constructor ({
    $window = window,
    $timeout = window.setTimeout,
    XMLHttpRequest = window.XMLHttpRequest,
    globalTags = [],
    timingRanges = {},
    codeRevision = 'local',
    stringReplace = [],
    blackList,
    whiteList,
    timelinePrefix = 'fsm_',
    enabled = true,
    bufferTime = 5000,
    metricNames = [],
    metricTags = [],
    eventTypes = [
      'timing',
      'set',
      'gauge',
      'increment',
      'histogram'
    ],
    timeParse = false,
    metricsServer,
    metricPrefix = ''
  } = {}
  ) {
    this.$window = $window
    this.$timeout = $timeout
    this.XMLHttpRequest = XMLHttpRequest

    this.globalTags = globalTags || [] // tags that will be applied to all metrics
    this.timingRanges = timingRanges
    this.codeRevision = codeRevision
    this.stringReplace = stringReplace
    this.blackList = blackList
    this.whiteList = whiteList
    this.timelinePrefix = timelinePrefix
    this.enabled = enabled
    this.bufTime = bufferTime
    this.cfgMetricNames = metricNames
    this.cfgMetricTags = metricTags
    this.cfgEventTypes = eventTypes
    this.timeParse = timeParse
    this.metricsServer = metricsServer
    this.metricPrefix = metricPrefix

    this.loadFired = false
    this.oneTimeMetrics = {}
    this.licenceUrls = []

    this.resetQueue()
    this.buildServerSharedDictionary()

    this.trackUnsupportedFeatures()

    this.upgradeQueue()
    this.trackExistingPerformanceEntries()
  }

  trackExistingPerformanceEntries () {
    if (!featureAvailable.performanceTimeline) {
      return
    }
    this.$window.performance.getEntries().forEach(entry => {
      if (entry.entryType === 'measure' || entry.entryType === 'resource') {
        this.performanceTiming(entry)
      }
    })
    this.timeParse !== 'true' && this.$window.performance.clearMeasures()
    featureAvailable.clearResourceTimings && this.$window.performance.clearResourceTimings()
  }

  trackUnsupportedFeatures () {
    if (!featureAvailable.navigationTiming) {
      this.increment('timingUnsupported')
    }

    if (!featureAvailable.mark) {
      this.increment('markUnsupported')
    }

    if (!featureAvailable.measure) {
      this.increment('markUnsupported')
    }

    if (!featureAvailable.performanceTimeline) {
      this.increment('resourceTimingUnsupported')
    }
  }

  buildServerSharedDictionary (metricNames, metricTags, eventTypes) {
    this.metricNames = {}
    this.metricTags = {}
    this.eventTypes = {}

    if (this.cfgMetricNames) {
      this.cfgMetricNames.forEach((v, i) => this.metricNames[v] = i)
    }

    if (this.cfgMetricTags) {
      this.cfgMetricTags.forEach((v, i) => this.metricTags[v] = '' + i)
    }

    if (this.cfgEventTypes) {
      this.cfgEventTypes.forEach((v, i) => this.eventTypes[v] = i)
    }
  }

  /*
   * Allows you to record metrics before datadog is available
   * Turns raw array into direct call to queueMetric
   * This way we can queue up metrics before this lib is loaded
   */
  upgradeQueue () {
    if (this.$window.fsMetrics &&
      Array.isArray(this.$window.fsMetrics) &&
      Array.prototype.push === this.$window.fsMetrics.push) {
      this.$window.fsMetrics.push = this.convertWindowQueue.bind(this)
      this.$window.fsMetrics.forEach(this.$window.fsMetrics.push)
    }
  }

  convertWindowQueue ([type, key, val = 1, tags = {}, andFlush = false]) {
    if (type === 'pageload') {
      tags.dest = key
      if (featureAvailable.navigationTiming) {
        var domTiming = window.performance.timing.domContentLoadedEventStart - window.performance.timing.navigationStart
        if (domTiming < 120000) {
          this.timing('domContentLoaded', domTiming, tags, true)
        } else {
          this.increment('timingOutlier', tags, true)
        }
      } else {
        this.increment('timingUnsupported', tags, true)
      }
    } else {
      if (typeof type === 'string') {
        type = this.eventTypes[type]
      }

      this.queueMetric(type, key, val, tags, andFlush)
    }
  }

  resetQueue () {
    this.queue = []
    if (this.activeBuffer) {
      this.$window.clearTimeout(this.activeBuffer)
    }
    this.activeBuffer = false
  }

  normalizeTag (tag) {
    tag += ''

    return this.stringReplace.reduce((tag, [search, replace]) => tag.replace(search, replace), tag)
  }

  // turns metricnames into smaller form
  encodeStat (...stats) {
    return stats.reduce((iv, stat) => {
      if (stat) { // && angular.isUndefined(this.metricNames[stat])) {
      // if (stat && !isDefined(this.metricNames[stat])) {
        stat += ''
        return iv + stat
        .replace(/[^\w:.-]+/g, '_') // turn statsc illegal chars into _
      } else if (stat && isDefined(this.metricNames[stat])) {
        return this.metricNames[stat]
      } else {
        return iv
      }
    }, '')
  }

  encodeTagsIntoMetricName (metricName, tags) {
    let tagstring = ''

    if (tags) {
      tagstring = '|' + JSON.stringify(tags)
    }

    return metricName + tagstring
  }

  // some metric names are reserved
  measureSafe (metricName, start, end, tags) {
    if (!featureAvailable.measure || !featureAvailable.timing) {
      return
    }

    if (!(start in window.performance.timing)) {
      start = this.timelinePrefix + start
    }
    if (!(end in window.performance.timing)) {
      end = this.timelinePrefix + end
    }

    try {
      this.$window.performance.measure(this.timelinePrefix + this.encodeTagsIntoMetricName(metricName, tags),
        start,
        end
      )
    } catch (e) {
      console.error(e)
    }
  }

  /**
   * mark the current point and create a measure
   */
  timingEvent (eventName, tags) {
    if (!featureAvailable.measure || !featureAvailable.mark) {
      return
    }

    this.$window.performance.mark(this.timelinePrefix + eventName)

    if (!this.timingRanges[eventName]) {
      return
    }

    for (let {from, metric, once} of this.timingRanges[eventName]) {
      if (!once || !this.oneTimeMetrics[metric]) {
        if (once) {
          this.oneTimeMetrics[metric] = true
        }

        if (eventName === 'stateChange.start' && from === 'domContentLoadedEventStart') {
          this.timing('timeToFirstRoute', this.$window.performance.now() - this.$window.performance.timing.domContentLoadedEventStart)
          return
        }

        this.measureSafe(metric, from, eventName, tags)
      }
    }
  }

  increment (metricName, tags = {}, andFlush = false) {
    this.queueMetric(this.eventTypes.increment, metricName, 1, tags, andFlush)
  }

  histogram (metricName, value, tags = {}, andFlush = false) {
    this.queueMetric(this.eventTypes.histogram, metricName, value, tags, andFlush)
  }

  timing (metricName, value, tags = {}, andFlush = false) {
    this.queueMetric(this.eventTypes.timing, metricName, value, tags, andFlush)
  }

  /*
   * given a PerformanceEntry log to datadog a measure or resource
   */
  performanceTiming (entry) {
    // only send whitelisted urls, ignore blacklisted
    if (!this.whiteList.test(entry.name) || this.blackList.test(entry.name)) {
      console.log(entry.name)
      return
    }

    if (entry.entryType === 'resource') {
      // this section is entirely for determining if a license request is OPTIONS
      // or the actual request
      if (entry.initiatorType === 'xmlhttprequest' &&
        this.licenceUrls.includes(entry.name)) {
        this.trackLicenseReq(entry)
      } else {
        this.timing('resourceTiming', entry.duration, {
          url: entry.name,
          initiatorType: entry.initiatorType,
          cached: !!(entry.decodedBodySize !== 0 && entry.transferSize === 0)
        })
      }
    } else if (entry.entryType === 'measure') {
      let [name, tags] = entry.name.split('|', 2)
      name = name.split(this.timelinePrefix, 2).pop()
      if (tags) {
        tags = JSON.parse(tags)
      }
      this.timing(name, entry.duration, tags)
    }
  }

  queueMetric (type = 'type is undefined', key = 'key is undefined', val, tags = {}, andFlush = false) {
    if (!this.enabled || this.$window.navigator.doNotTrack) {
      return false
    }

    if (val !== 0 && !val) {
      return
    }

    // log timings over 2 minutes, they're probably outliers or errors
    if (type === this.eventTypes.timing && (!this.$window.isFinite(val) || val > 120000 || val < 0)) {
      this.increment('timingOutlier')
      return
    }

    this.queue.push({type, key, val, tags})

    if (andFlush) {
      this.flushMetrics()
    } else if (!this.activeBuffer) {
      // Using setTimeout instead of $timeout here as $timeout blocks
      // Protractor tests from running
      this.activeBuffer = this.$window.setTimeout(
        this.flushMetrics.bind(this),
        this.bufTime || 5000
      )
    }
  }

  // collapses object to array of tagname:tagval + converts that tag to simple form
  encodeTags (tags) {
    const encoded = []
    for (let tagName in tags) {
      encoded.push(`${tagName}:${this.normalizeTag(tags[tagName])}`)
    }

    return encoded
  }

  buildDict (string, stringDict) {
    if (!stringDict[string]) {
      stringDict[string] = stringDict.id++
    }

    return stringDict[string]
  }

  encodeMetric (metric, stringDict) {
    if (metric.type === 0 || metric.type === 3 || metric.type === 5) {
      metric.val = metric.val | 0
    }
    metric.tags = this.encodeTags(metric.tags)
    metric.key = this.encodeStat(metric.key)

    // turn strings into numbers and send the dictionary along
    metric.key = this.buildDict(metric.key, stringDict)
    metric.tags = metric.tags.map(string => this.buildDict(string, stringDict))

    if (typeof metric.val === 'string') {
      metric.val = this.buildDict(metric.val, stringDict)
    }
  }

  preparePayload (queue) {
    const msgJSON = {
      'codeSha': this.codeRevision,
      'globalTag': this.globalTags.slice(),
      'aMetric': [],
      'prefix': this.metricPrefix
    }

    const stringDict = {}
    Object.defineProperty(stringDict, 'id', {
      value: 0,
      writable: true,
      configurable: false,
      enumerable: false
    })

    // TODO figure out how to get the lib to do this conversion for us
    const MetricValue = {
      0: 'metricValueTiming',
      1: 'metricValueSet',
      2: 'metricValueGauge',
      3: 'metricValueIncrement',
      4: 'metricValueHistogram',
      5: 'metricValueIncrement',
      6: 'metricValueEvent'
    }
    // type key val tags
    // type name tag value
    for (let metric of queue) {
      // encodeTags
      // encodeStat
      this.encodeMetric(metric, stringDict)

      msgJSON.aMetric.push({
        tag: metric.tags,
        type: metric.type,
        metricName: metric.key,
        [MetricValue[metric.type]]: metric.val
      })
    }

    // flip keys and values
    msgJSON.stringDict = invertObjectKV(stringDict)
    console.log(msgJSON.stringDict)
    console.log(msgJSON)

    const error = metricsMessage.verify(msgJSON)
    if (error) {
      console.error(error)
      return
    }

    return metricsMessage.encode(metricsMessage.create(msgJSON)).finish()
  }

  flushMetrics () {
    // since we aren't using $http we have to use other means to get the request
    // to not be made while running tests
    const oreq = new this.XMLHttpRequest()
    oreq.open('PUT', this.metricsServer)
    oreq.setRequestHeader('Content-Type', 'application/octet-stream')
    const payload = this.preparePayload(this.queue)
    if (payload) {
      oreq.send(payload)
    }

    this.resetQueue()
  }
}
