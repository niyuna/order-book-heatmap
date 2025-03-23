import WebSocket from 'isomorphic-ws';
import axios from 'axios';
import { isBrowser, noop } from './utils.js';
import apiConf from '../config/binance/api.js';
import exchangeConf from '../config/binance/exchange-info.js';

// TODO generate a listen key for long lasting connections
// not necessary at this point, consider adding later


export default class BinanceDataFeed {
  constructor(endpoint = apiConf.wsEndpoint) {
    this.endpoint = endpoint;
    this.heartbeatInterval = null;
    this.lastSubId = 0;

    // exchange symbols info
    this.symbols = {};
    // subscription_id => subscription stream object
    this.subscriptions = {};
    // denormalized flat hash table for fast event to callback lookups
    // lets users of this class parse only the events they care about
    this.streamIndex = {};

    // supported WS streams
    this.eventHandlers = {
      depth: 'onDepth',
      aggDepth: 'onAggDepth',
      trade: 'onTrade',
      aggTrade: 'onAggTrade',
      ticker: 'onTicker',
      bookTicker: 'onBookTicker',
      miniTicker: 'onMiniTicker',
      kline_1m: 'onKline'
    };
    // TODO for long running applications, use the exchange info rest call as
    // well to make sure data is not out of date
    for (let i = 0, l = exchangeConf.symbols.length; i < l; i++) {
      this.symbols[ exchangeConf.symbols[i].symbol ] = exchangeConf.symbols[i];
    }
  }

  /*
   * Subscribe to 1..N symbols
   * @param {string | Array[string]} symbols
   * @param {object} callback - event handlers for all supported WS strems
   *  onDepth(event, symbol)
   *  onTrade(event, symbol)
   *  onTicker(event, symbol)
   *
   * @return {subscription} - websocket reference with subscription details
   *
   * A single WS connection will be opened, which will combine all streaming
   * events. The WS connection won't subscribe to specific event types if an
   * event handler for that type is not defined, to aleviate the network load.
   */
  subscribe(symbols, callbacks) {
    const id = this.lastSubId++;
    symbols = this.parseInputs(symbols, callbacks);
    const streamKeys = this.getStreamKeys(symbols, callbacks);
    // Open a new WS connection only for the streams that are not
    // already evailable through existing connections
    const unavailableStreamKeys = this.getUnavailableStreamKeys(streamKeys);
    const urlParams = this.getQueryParams(unavailableStreamKeys);
    const url = `${this.endpoint}${urlParams}`;
    // use the base64 encoded url as the subscription id
    this.updateStreamIndex(streamKeys, callbacks, id);

    // reuse existing connections if all streams are already accessible
    // through existing WS connections
    let subscription = {};
    if (unavailableStreamKeys.length) {
      subscription = new WebSocket(url);

      subscription.onopen = this.handleOpen;
      subscription.onclose = this.handleClose;
      subscription.onmessage = this.handleMessage;
      subscription.onerror = this.handleError;

      // WS does not have a pong handler in the browser
      if (! isBrowser())
        subscription.on('pong', this.handlePong);
    } else {
      subscription.reused = true;
    }

    subscription.isActive = true;
    subscription.streamKeys = streamKeys;
    subscription.streamIndex = this.streamIndex;
    subscription.id = id;
    subscription.onError = callbacks.onError || noop;
    subscription.onLog = callbacks.onLog || noop;

    this.subscriptions[id] = subscription;

    return subscription;
  };

  unsubscribe(subscription) {
    let id = subscription;
    if (typeof subscription === 'object')
      id = subscription.id;

    const streams = this.subscriptions[id].streamKeys;

    for (let i = streams.length - 1; i >= 0; i--) {
      const s = this.streamIndex[ streams[i] ];
      if (s.subscriptions.length === 1) {
        delete this.streamIndex[ streams[i] ];
        streams.splice(streams.indexOf(streams[i]), 1);
      } else {
        const index = s.subscriptions.indexOf(id);
        s.subscriptions.splice(index, 1);
        s.callbacks.splice(index, 1);
      }
    }

    // close the socket if all data streams owned by this subscription are not longer needed
    // it is possible that other connections could be reusing the same socket,
    // if that's the case the socket will close when all other connections
    // reusing the same streams close as well.
    if (!streams.length) {
      // fully reused subscriptions don't have their own sockets, there's
      // nothing to close
      if (!this.subscriptions[id].reused) {
        this.subscriptions[id].removeAllListeners('message');
        this.subscriptions[id].close();
      }

      delete this.subscriptions[id];
    }
  }

  // TODO move endpoints & defaults to config
  getOrderBookSnapshot(symbol, handler) {
    const url = `${apiConf.restEndpoint}depth?symbol=${symbol}&limit=${apiConf.depthSnapshotLimit}`;
    axios.get(url)
      .then(resp => handler(resp.data))
      .catch((e) => {
        console.error('Order Book Snapshot error: ', e);
      });
  }

  getExchangeInfo(handler) {
    const url = `${apiConf.restEndpoint}exchangeInfo`;
    axios.get(url)
      .then(resp => handler(resp.data))
      .catch((e) => {
        console.error('Exchange info error: ', e);
      });
  }

  getSymbolTickSize(symbol) {
    return this.symbols[symbol].filters[0].tickSize;
  }

  parseInputs(symbols, callbacks) {
    if (!symbols || symbols.length === 0)
      console.error('Please provide 1 or more Binance symbols');

    const cbKeys = Object.keys(callbacks);
    if (!callbacks || cbKeys.length === 0)
      console.error('Please provide 1 or more Binance symbols');

    for (let i = 0, l = cbKeys.length; i < l; i++) {
      if (typeof callbacks[ cbKeys[i] ] !== 'function')
        console.error('Invalid callback');
    }

    if (!Array.isArray(symbols))
      symbols = [symbols];

    return symbols.map(s => s.toLowerCase());
  }

  updateStreamIndex(keys, callbacks, id) {
    const getCallbackIndex = (i) => i % callbacks.length;

    for (let i = 0, l = keys.length; i < l; i++) {
      if (!this.streamIndex[ keys[i] ]) {
        const keyParts = keys[i].split('@');
        this.streamIndex[ keys[i] ] = {
          callbacks: [],
          subscriptions: [],
          symbol: keyParts[0],
          type: keyParts[1]
        }
      }

      // keep a denormalized array of all callback functions listening for
      // this specific type of event, for quick access
      const s = this.streamIndex[ keys[i] ];
      const callbackKey = this.eventHandlers[ s.type ];
      s.callbacks.push( callbacks[callbackKey] );
      // keep track of all active subscriptions listening to this stream
      // to avoid opening new websockets, when existing subscriptions already receive
      // events of the desired type
      this.streamIndex[ keys[i] ].subscriptions.push(id);
    }
  }

  // build the list of all the requires WS stream keys
  getStreamKeys(symbols, hasEventHandler) {
    let s = [];

    const handlers = Object.values(this.eventHandlers);
    const keys = Object.keys(this.eventHandlers);

    // build the stream keys for all handlers of all symbols
    for (let i = 0, l = symbols.length; i < l; i++) {
      for (let j = 0, k = handlers.length; j < k; j++) {
        const key = keys[j];
        const handlerName = this.eventHandlers[key];

        // don't create a streamKey if a handler is not defined
        if (hasEventHandler[ handlerName ]) {
          let streamKey = `${symbols[i]}@${key}`;

          // TODO? support slower connections if necessary (1000ms)
          // or <20 levels for aggregated depth
          if (handlers[j] === 'onDepth')
            streamKey = `${streamKey}@${apiConf.wsDepthFreq}`;
          if (handlers[j] === 'onAggDepth')
            streamKey = `${symbols[i]}@depth@${apiConf.wsAggDepthLevels}@${apiConf.wsDepthFreq}`;

          s.push(streamKey);
        }
      }
    }

    return s;
  }

  getUnavailableStreamKeys(keys) {
    return keys.filter(key => !this.streamIndex[key]);
  }

  // required stream keys to an array & use it to
  // build the WSS stream param url. Ignore streams with no
  // user-defined event handlers
  getQueryParams(streams) {
    return streams.join('/');
  }

  // create a new periodical heartbeat call to keep the WS streams active
  // for more than 30 minutes
  handleOpen() {
    if (this.heartbeatInterval === null && !isBrowser())
      this.heartbeatInterval = setInterval(
        () => { this.heartbeat(this.subscriptions) },
        apiConf.wsPingInterval);
  }

  // stop the WS ping calls if there are no active subscriptions
  handleClose() {
    if (Object.keys(this.subscriptions).length === 0) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  handleMessage(msg) {
    try {
      let event = JSON.parse(msg.data);
      const s = this.streamIndex[event.stream];

      // push fresh market data to all functions listening for this event stream
      for (let i = 0, l = s.callbacks.length; i < l; i++) {
        s.callbacks[i](event.data, s.symbol);
      } 
    } catch (e) {
      this.onError(`Invalid JSON response from Binance: ${msg}`);
    }
  }

  handleError(e) {
    this.onError(e);
  }

  //send a ping to all active subscriptions
  heartbeat(subscriptions) {
    const l = Object.keys(subscriptions).length;

    for (let i = 0; i < l; i++) {
      const sub = subscriptions[i];

      // the WS has not received a pong from Binance since the last ping
      // the connection is no longer active, close the subscription and
      // notify the client
      if (! sub.isActive) {
        sub.onError('WebSocket connection is no longer active. Binance did not return a response it time.');
        sub.close(sub);
      }

      sub.ping(() => {});
      sub.isActive = false;
    }
  }

  handlePong() {
    subscription.isActive = true;
  }

  /**
   * 获取指定时间范围内的历史数据
   * @param {string} symbol - 交易对符号
   * @param {number} startTime - 开始时间戳（毫秒）
   * @param {number} endTime - 结束时间戳（毫秒）
   * @param {number} updateInterval - 数据点之间的时间间隔（毫秒）
   * @returns {Promise<Object>} - 包含热图数据和交易数据的对象
   */
  async getHistoricalData(symbol, startTime, endTime, updateInterval) {
    try {
      // 验证参数
      if (!symbol || !startTime || !endTime || !updateInterval) {
        throw new Error('Missing required parameters');
      }

      if (endTime <= startTime) {
        throw new Error('End time must be greater than start time');
      }

      // 计算需要获取的数据点数量
      const totalDuration = endTime - startTime;
      const dataPointsCount = Math.ceil(totalDuration / updateInterval);

      // 构建 API 请求 URL
      // 注意：这里使用 Binance 的历史 k 线数据 API
      const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
      
      // 获取 k 线数据
      const klineResponse = await fetch(klineUrl);
      const klineData = await klineResponse.json();

      // 获取历史交易数据
      // 注意：Binance 的历史交易 API 有限制，可能需要分页获取
      const tradesUrl = `https://api.binance.com/api/v3/aggTrades?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
      const tradesResponse = await fetch(tradesUrl);
      const tradesData = await tradesResponse.json();

      // 处理数据，按照 updateInterval 进行分组
      const result = {
        heatmapData: [],
        tradesData: []
      };

      // 处理 k 线数据，生成热图数据点
      for (let i = 0; i < dataPointsCount; i++) {
        const pointTime = startTime + i * updateInterval;
        const nextPointTime = pointTime + updateInterval;

        // 找出这个时间段内的 k 线数据
        const periodKlines = klineData.filter(kline => {
          const klineTime = parseInt(kline[0]);
          return klineTime >= pointTime && klineTime < nextPointTime;
        });

        // 计算这个时间段的订单簿快照
        const snapshot = this.calculateOrderBookSnapshot(periodKlines);

        // 添加到结果中
        if (snapshot) {
          result.heatmapData.push({
            timestamp: pointTime,
            snapshot: snapshot
          });
        }
      }

      // 处理交易数据
      result.tradesData = tradesData.map(trade => ({
        id: trade.a,
        price: parseFloat(trade.p),
        quantity: parseFloat(trade.q),
        time: trade.T,
        isBuyerMaker: trade.m
      }));

      return result;
    } catch (error) {
      console.error('Error fetching historical data:', error);
      throw error;
    }
  }

  /**
   * 根据 k 线数据计算订单簿快照
   * @param {Array} klines - k 线数据
   * @returns {Object} - 订单簿快照
   */
  calculateOrderBookSnapshot(klines) {
    if (klines.length === 0) return null;

    // 这里是一个简化的实现，实际上需要更复杂的逻辑来模拟订单簿
    // 在实际应用中，您可能需要使用更复杂的算法或获取真实的历史订单簿数据

    // 从 k 线数据中提取价格信息
    const open = parseFloat(klines[0][1]);
    const high = Math.max(...klines.map(k => parseFloat(k[2])));
    const low = Math.min(...klines.map(k => parseFloat(k[3])));
    const close = parseFloat(klines[klines.length - 1][4]);
    const volume = klines.reduce((sum, k) => sum + parseFloat(k[5]), 0);

    // 计算买卖订单的分布
    const midPrice = (high + low) / 2;
    const spread = high - low;
    const tickSize = this.getSymbolTickSize(klines[0][0].split('_')[0]);
    
    // 创建模拟的订单簿数据
    const asks = [];
    const bids = [];
    
    // 生成卖单（asks）
    for (let i = 0; i < 10; i++) {
      const price = midPrice + (i + 1) * tickSize;
      const size = Math.random() * volume * 0.1;
      asks.push([price.toFixed(8), size.toFixed(8)]);
    }
    
    // 生成买单（bids）
    for (let i = 0; i < 10; i++) {
      const price = midPrice - (i + 1) * tickSize;
      const size = Math.random() * volume * 0.1;
      bids.push([price.toFixed(8), size.toFixed(8)]);
    }
    
    // 创建订单簿快照
    return {
      lastUpdateId: Date.now(),
      bids: bids,
      asks: asks,
      stats: {
        open: open,
        high: high,
        low: low,
        close: close,
        volume: volume,
        mktBuySize: volume * 0.6, // 假设 60% 是买单
        mktSellSize: volume * 0.4, // 假设 40% 是卖单
        mktBuyOrders: Math.floor(volume * 0.01),
        mktSellOrders: Math.floor(volume * 0.008),
        avgBuyVWAP: (midPrice + high) / 2,
        avgSellVWAP: (midPrice + low) / 2
      }
    };
  }
}
