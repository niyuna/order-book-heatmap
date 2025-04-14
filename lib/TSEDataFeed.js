// 添加 fallback 时间戳常量
const FALLBACK_DATE_ISO = '2025-04-14T10:00:00+09:00';
const FALLBACK_TIMESTAMP = new Date(FALLBACK_DATE_ISO).getTime();

export default class TSEDataFeed {
  constructor() {
    this.callbacks = {
      trade: [],
      depth: []
    };
    
    // 添加 fallback 时间戳作为类属性，方便外部访问
    this.fallbackTimestamp = FALLBACK_TIMESTAMP;
    this.fallbackDateISO = FALLBACK_DATE_ISO;
    
    // 初始化股票代码的价格刻度映射
    this.tickSizes = {
      // 默认刻度为 1.0
      'default': '1.0',
      
      // 添加一些模拟数据
      '1301': '0.1',    // 东京证券交易所股票示例
      '3382': '0.5',
      '4755': '1.0',
      '6758': '5.0',    // Sony
      '7203': '1.0',    // Toyota
      '8306': '0.5',    // 三菱UFJ金融集团
      '9432': '0.1',    // NTT
      '9984': '1.0',    // 软银集团
      '7011': '0.5',
      '5016': '1.0',
      '6758': '1.0',    // 索尼
      '6762': '0.5',    // TDK
      '215A': '1.0',     // timee
      '7013': '5.0',
    };
    
    // 初始化 TSE 数据源连接
    this.initConnection();
  }
  
  initConnection() {
    // 实现 TSE 数据源连接逻辑
    console.log('TSE data feed connection initialized');
  }
  
  /**
   * 获取特定股票代码的价格刻度
   * @param {string} symbol - 股票代码
   * @returns {string} - 价格刻度
   */
  getSymbolTickSize(symbol) {
    // 如果存在特定股票代码的刻度，则返回该刻度
    // 否则返回默认刻度
    return this.tickSizes[symbol] || this.tickSizes['default'];
  }
  
  /**
   * 订阅数据
   * @param {string} symbol - 股票代码
   * @param {Object} callbacks - 回调函数对象
   * @returns {Object} - 包含取消订阅方法的对象
   */
  subscribe(symbol, callbacks) {
    console.log(`Subscribing to ${symbol} data`);
    
    // 创建订阅对象
    const subscription = {
      symbol,
      callbacks,
      active: true,
      lastEndTime: null,
      updateInterval: 1000, // 默认更新间隔为1秒
      timer: null,
      unsubscribe: () => {
        console.log(`Unsubscribing from ${symbol} data`);
        subscription.active = false;
        if (subscription.timer) {
          clearInterval(subscription.timer);
          subscription.timer = null;
        }
        // 从订阅列表中移除
        const index = this.subscriptions.indexOf(subscription);
        if (index !== -1) {
          this.subscriptions.splice(index, 1);
        }
      }
    };
    
    // 如果没有订阅列表，创建一个
    if (!this.subscriptions) {
      this.subscriptions = [];
    }
    
    // 添加到订阅列表
    this.subscriptions.push(subscription);
    
    // 开始模拟数据流
    this.startDataSimulation(subscription);
    
    // 返回订阅对象
    return subscription;
  }
  
  /**
   * 开始数据模拟
   * @param {Object} subscription - 订阅对象
   */
  startDataSimulation(subscription) {
    // 检查市场状态
    const marketStatus = this.isMarketOpen();
    
    // 初始化开始时间
    let startTime;
    if (subscription.lastEndTime) {
      // 如果有上次的结束时间，使用它作为开始时间
      startTime = subscription.lastEndTime;
    } else if (marketStatus.open) {
      // 如果市场开放且没有上次的结束时间，使用当前时间
      startTime = Date.now();
    } else {
      // 如果市场关闭且没有上次的结束时间，使用 fallback 时间戳
      startTime = this.fallbackTimestamp;
      // 标记使用了 fallback 时间戳
      subscription.usingFallback = true;
    }
    
    // 设置定时器，每秒获取一次数据
    subscription.timer = setInterval(async () => {
      if (!subscription.active) {
        clearInterval(subscription.timer);
        return;
      }
      
      try {
        // 计算结束时间（开始时间 + 更新间隔）
        const endTime = startTime + subscription.updateInterval;
        
        // 调用 historical-data API 获取数据
        const data = await this.getHistoricalData(
          subscription.symbol,
          startTime,
          endTime,
          subscription.updateInterval
        );
        
        // 更新上次的结束时间
        subscription.lastEndTime = endTime;
        
        // 更新下一次的开始时间
        startTime = endTime;
        
        // 处理获取到的数据
        this.processHistoricalData(data, subscription);
        
      } catch (error) {
        console.error('Error in data simulation:', error);
      }
    }, subscription.updateInterval);
    
    console.log(`Started data simulation for ${subscription.symbol}`);
  }
  
  /**
   * 处理历史数据并触发回调
   * @param {Object} data - 历史数据
   * @param {Object} subscription - 订阅对象
   */
  processHistoricalData(data, subscription) {
    // 检查数据是否有效
    if (!data || !data.heatmapData || data.heatmapData.length === 0) {
      console.log('No historical data available');
      return;
    }
    
    // 获取最新的热图数据
    const latestHeatmapData = data.heatmapData[data.heatmapData.length - 1];
    
    // 如果有深度数据回调，触发它
    if (subscription.callbacks.onDepth && latestHeatmapData.snapshot) {
      // 转换为 BinanceOrderBook 期望的格式
      const depthData = this.convertToBinanceDepthFormat(latestHeatmapData.snapshot, latestHeatmapData.timestamp);
      
      subscription.callbacks.onDepth(depthData);
    }
    
    // 如果有 BookTicker 回调，触发它
    if (subscription.callbacks.onBookTicker && latestHeatmapData.snapshot) {
      // 转换为 BookTicker 格式
      const bookTickerData = this.convertToBookTickerFormat(latestHeatmapData.snapshot);
      
      subscription.callbacks.onBookTicker(bookTickerData);
    }
    
    // 如果有交易数据回调，触发它
    if (subscription.callbacks.onTrade && data.tradesData && data.tradesData.length > 0) {
      data.tradesData.forEach(trade => {
        // 转换为 BinanceOrderBook 期望的交易格式
        const tradeData = this.convertToBinanceTradeFormat(trade);
        subscription.callbacks.onTrade(tradeData);
      });
    }
  }
  
  /**
   * 将订单簿快照转换为 Binance 深度数据格式
   * @param {Object} snapshot - 订单簿快照
   * @param {number} timestamp - 时间戳
   * @returns {Object} - Binance 格式的深度数据
   */
  convertToBinanceDepthFormat(snapshot, timestamp) {
    // Binance 深度数据格式:
    // {
    //   U: number, // 更新ID下限
    //   u: number, // 更新ID上限
    //   a: Array<[string, string]>, // 卖单 [价格, 数量]
    //   b: Array<[string, string]>  // 买单 [价格, 数量]
    // }
    
    return {
      U: snapshot.lastUpdateId - 1,
      u: snapshot.lastUpdateId,
      a: snapshot.asks || [],
      b: snapshot.bids || [],
      E: timestamp // 事件时间
    };
  }
  
  /**
   * 将订单簿快照转换为 BookTicker 格式
   * @param {Object} snapshot - 订单簿快照
   * @returns {Object} - BookTicker 格式的数据
   */
  convertToBookTickerFormat(snapshot) {
    // BookTicker 格式:
    // {
    //   u: number,  // 更新ID
    //   s: string,  // 交易对
    //   b: string,  // 买一价
    //   B: string,  // 买一量
    //   a: string,  // 卖一价
    //   A: string   // 卖一量
    // }
    
    // 获取买一价和卖一价
    let bestBid = ['0', '0'];
    let bestAsk = ['0', '0'];
    
    if (snapshot.bids && snapshot.bids.length > 0) {
      // 买单按价格降序排列，第一个是最高买价
      bestBid = snapshot.bids[0];
    }
    
    if (snapshot.asks && snapshot.asks.length > 0) {
      // 卖单按价格升序排列，第一个是最低卖价
      bestAsk = snapshot.asks[0];
    }
    
    return {
      u: snapshot.lastUpdateId,
      s: 'UNKNOWN',  // 交易对未知，可以从订阅中获取
      b: bestBid[0], // 买一价
      B: bestBid[1], // 买一量
      a: bestAsk[0], // 卖一价
      A: bestAsk[1]  // 卖一量
    };
  }
  
  /**
   * 将交易数据转换为 Binance 交易格式
   * @param {Object} trade - 交易数据
   * @returns {Object} - Binance 格式的交易数据
   */
  convertToBinanceTradeFormat(trade) {
    // Binance 交易数据格式:
    // {
    //   t: number,  // 交易ID
    //   p: string,  // 价格
    //   q: string,  // 数量
    //   T: number,  // 时间戳
    //   m: boolean, // 是否是卖方发起的交易
    // }
    
    return {
      t: trade.id || Date.now(),
      p: trade.price.toString(),
      q: trade.quantity.toString(),
      T: trade.timestamp || Date.now(),
      m: trade.isBuyerMaker // Binance 中 m=false 表示卖方发起
    };
  }
  
  /**
   * 关闭连接
   */
  close() {
    console.log('Closing TSE data feed connection');
    // 清理所有订阅
    if (this.subscriptions) {
      this.subscriptions.forEach(subscription => {
        if (subscription.timer) {
          clearInterval(subscription.timer);
          subscription.timer = null;
        }
      });
      this.subscriptions = [];
    }
    // 清理回调
    this.callbacks = {
      trade: [],
      depth: []
    };
  }
  
  /**
   * 获取订单簿快照
   * @param {string} symbol - 股票代码
   * @param {Function} callback - 回调函数
   */
  getOrderBookSnapshot(symbol, callback) {
    console.log(`Getting order book snapshot for ${symbol}`);
    
    // 检查市场状态
    const marketStatus = this.isMarketOpen();
    
    // 确定开始时间
    let startTime;
    if (marketStatus.open) {
      // 如果市场开放，使用当前时间减去1分钟
      startTime = Date.now() - 60000;
    } else {
      // 如果市场关闭，使用 fallback 时间戳
      startTime = this.fallbackTimestamp;
    }
    
    // 确定结束时间（开始时间 + 1秒）
    const endTime = startTime + 60000;
    
    // 调用 historical-data API 获取数据
    this.getHistoricalData(symbol, startTime, endTime, 1000)
      .then(data => {
        if (data && data.heatmapData && data.heatmapData.length > 0) {
          // 获取最新的热图数据
          const latestHeatmapData = data.heatmapData[data.heatmapData.length - 1];
          
          // 调用回调函数
          callback(latestHeatmapData.snapshot);
        } else {
          // 如果没有数据，生成模拟数据
          const snapshot = this.generateMockSnapshot(symbol, startTime);
          callback(snapshot);
        }
      })
      .catch(error => {
        console.error('Error getting order book snapshot:', error);
        // 出错时生成模拟数据
        const snapshot = this.generateMockSnapshot(symbol, startTime);
        callback(snapshot);
      });
  }
  
  /**
   * 生成模拟的深度数据
   * @param {string} symbol - 股票代码
   * @returns {Object} - 深度数据
   */
  generateMockDepthData(symbol) {
    const basePrice = 1000;
    const tickSize = parseFloat(this.getSymbolTickSize(symbol));
    
    return {
      U: Date.now() - 1000,
      u: Date.now(),
      a: [
        [basePrice + tickSize, Math.random() * 10],
        [basePrice + tickSize * 2, Math.random() * 10]
      ],
      b: [
        [basePrice - tickSize, Math.random() * 10],
        [basePrice - tickSize * 2, Math.random() * 10]
      ]
    };
  }
  
  /**
   * 生成模拟的订单簿快照
   * @param {string} symbol - 股票代码
   * @param {number} timestamp - 时间戳
   * @returns {Object} - 订单簿快照
   */
  generateMockSnapshot(symbol, timestamp) {
    // 生成随机价格
    const basePrice = 1000;
    const tickSize = parseFloat(this.getSymbolTickSize(symbol));
    
    // 创建模拟的订单簿数据
    const asks = [];
    const bids = [];
    
    // 生成卖单（asks）
    for (let i = 0; i < 10; i++) {
      const price = basePrice + (i + 1) * tickSize;
      const size = Math.random() * 100;
      asks.push([price.toFixed(2), size.toFixed(2)]);
    }
    
    // 生成买单（bids）
    for (let i = 0; i < 10; i++) {
      const price = basePrice - (i + 1) * tickSize;
      const size = Math.random() * 100;
      bids.push([price.toFixed(2), size.toFixed(2)]);
    }
    
    // 创建订单簿快照
    return {
      lastUpdateId: timestamp,
      bids: bids,
      asks: asks
    };
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
      // 将时间戳转换为 ISO 格式
      const startTimeISO = new Date(startTime).toISOString();
      const endTimeISO = new Date(endTime).toISOString();
      
      // 调用 API 获取历史数据，传递 updateInterval 参数
      const response = await fetch(`http://localhost:8000/historical-data/${symbol}?start_time=${startTimeISO}&end_time=${endTimeISO}&update_interval=${updateInterval}`);
      
      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }
      
      const data = await response.json();
      
      // 如果需要，可以在这里对数据进行进一步处理
      // 例如，根据 updateInterval 对数据进行重采样
      
      return data;
    } catch (error) {
      console.error('Error fetching historical data:', error);
      throw error;
    }
  }
  
  /**
   * 检查东京证券交易所 (TSE) 是否开放
   * @param {Date} [date=new Date()] - 要检查的日期时间，默认为当前时间
   * @returns {Object} - 包含市场状态信息的对象
   */
  isMarketOpen(date = new Date()) {
    // 转换为日本时间
    const jpDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const day = jpDate.getDay();
    const hours = jpDate.getHours();
    const minutes = jpDate.getMinutes();
    const time = hours * 60 + minutes; // 转换为分钟计数，方便比较
    
    // 检查是否为周末 (0 = 周日, 6 = 周六)
    if (day === 0 || day === 6) {
      return {
        open: false,
        reason: '周末市场休市',
        nextOpenTime: this.getNextOpenTime(jpDate)
      };
    }
    
    // 定义交易时段 - 更新为实际的 bookmap 更新时间
    const morningOpen = 8 * 60; // 8:00 (bookmap 更新开始时间)
    const morningClose = 11 * 60 + 30; // 11:30
    const afternoonOpen = 12 * 60 + 30; // 12:30
    const afternoonClose = 15 * 60 + 30; // 15:30 (2024年11月5日后的结束时间)
    
    // 检查是否在交易时段内
    const isInMorningSession = time >= morningOpen && time < morningClose;
    const isInAfternoonSession = time >= afternoonOpen && time < afternoonClose;
    
    if (isInMorningSession || isInAfternoonSession) {
      return {
        open: true,
        session: isInMorningSession ? 'morning' : 'afternoon',
        timeRemaining: isInMorningSession ? 
          morningClose - time : 
          afternoonClose - time
      };
    } else {
      // 市场已关闭，确定原因和下一次开放时间
      let reason;
      if (time < morningOpen) {
        reason = '早市尚未开始';
      } else if (time >= morningClose && time < afternoonOpen) {
        reason = '午休时间';
      } else {
        reason = '交易日已结束';
      }
      
      return {
        open: false,
        reason: reason,
        nextOpenTime: this.getNextOpenTime(jpDate)
      };
    }
  }
  
  /**
   * 获取下一个市场开放时间
   * @param {Date} currentJpDate - 当前日本时间
   * @returns {Date} - 下一个市场开放时间
   */
  getNextOpenTime(currentJpDate) {
    const day = currentJpDate.getDay();
    const hours = currentJpDate.getHours();
    const minutes = currentJpDate.getMinutes();
    const time = hours * 60 + minutes;
    
    // 创建一个新的日期对象，以便修改
    const nextOpenDate = new Date(currentJpDate);
    
    // 定义交易时段 - 更新为实际的 bookmap 更新时间
    const morningOpen = 8 * 60; // 8:00 (bookmap 更新开始时间)
    const morningClose = 11 * 60 + 30; // 11:30
    const afternoonOpen = 12 * 60 + 30; // 12:30
    const afternoonClose = 15 * 60 + 30; // 15:30 (2024年11月5日后的结束时间)
    
    // 根据当前时间确定下一个开市时间
    if (day === 5 && time >= afternoonClose) {
      // 周五收市后，下一个开市时间是下周一
      nextOpenDate.setDate(nextOpenDate.getDate() + 3);
      nextOpenDate.setHours(8, 0, 0, 0); // 更新为 8:00
    } else if (day === 6) {
      // 周六，下一个开市时间是下周一
      nextOpenDate.setDate(nextOpenDate.getDate() + 2);
      nextOpenDate.setHours(8, 0, 0, 0); // 更新为 8:00
    } else if (day === 0) {
      // 周日，下一个开市时间是周一
      nextOpenDate.setDate(nextOpenDate.getDate() + 1);
      nextOpenDate.setHours(8, 0, 0, 0); // 更新为 8:00
    } else if (time < morningOpen) {
      // 当天早市开始前
      nextOpenDate.setHours(8, 0, 0, 0); // 更新为 8:00
    } else if (time >= morningClose && time < afternoonOpen) {
      // 午休时间
      nextOpenDate.setHours(12, 30, 0, 0);
    } else if (time >= afternoonClose) {
      // 当天收市后，下一个开市时间是明天
      nextOpenDate.setDate(nextOpenDate.getDate() + 1);
      nextOpenDate.setHours(8, 0, 0, 0); // 更新为 8:00
      
      // 如果明天是周六，则跳到下周一
      if (nextOpenDate.getDay() === 6) {
        nextOpenDate.setDate(nextOpenDate.getDate() + 2);
      }
    }
    
    return nextOpenDate;
  }
} 