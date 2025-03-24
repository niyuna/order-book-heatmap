export default class TSEDataFeed {
  constructor() {
    this.callbacks = {
      trade: [],
      depth: []
    };
    
    // 初始化股票代码的价格刻度映射
    this.tickSizes = {
      // 默认刻度为 0.01
      'default': '1.0',
      
      // 添加一些模拟数据
      '1301': '0.1',    // 东京证券交易所股票示例
      '3382': '0.5',
      '4755': '1.0',
      '6758': '5.0',    // Sony
      '7203': '1.0',    // Toyota
      '8306': '0.1',    // 三菱UFJ金融集团
      '9432': '0.5',    // NTT
      '9984': '10.0',    // 软银集团
      '7011': '0.5',
      '5016': '1.0',
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
      unsubscribe: () => {
        console.log(`Unsubscribing from ${symbol} data`);
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
    
    // 模拟初始订单簿数据
    setTimeout(() => {
      if (callbacks.onDepth) {
        const mockDepthData = this.generateMockDepthData(symbol);
        callbacks.onDepth(mockDepthData);
      }
    }, 500);
    
    // 返回订阅对象
    return subscription;
  }
  
  /**
   * 关闭连接
   */
  close() {
    console.log('Closing TSE data feed connection');
    // 清理所有订阅
    if (this.subscriptions) {
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
    
    // 生成模拟的订单簿快照
    const snapshot = this.generateMockSnapshot(symbol, Date.now());
    
    // 调用回调函数
    setTimeout(() => {
      callback(snapshot);
    }, 100);
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
} 