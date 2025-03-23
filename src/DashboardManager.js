import Dashboard from './Dashboard.js';
import BinanceDataFeed from '../lib/BinanceDataFeed.js';
import TSEDataFeed from '../lib/TSEDataFeed.js'; // 假设您有这个类

// TODO handle more than 1 Dashboard at the same time
// trivial to do, with the cuttent code structure, just
// not needed for now

// Dashboard parent class to manage multiple objects & allow
// reuse of the same data feed. OrderBook is not reused for
// multiple connections atm, although it is doable if needed
export default class DashboardManager {
  constructor() {
    this.dashboard = null;
    this.feed = null;
  }

  createDashboard(feedType, symbol, tickSize, updateInterval, levels, aggregation, maxSeriesLength, scale, theme) {
    // 清除现有仪表板
    this.clearDashboard();
    
    // 创建数据源
    let feed;
    if (feedType === 'binance') {
      feed = new BinanceDataFeed();
    } else if (feedType === 'tse') {
      feed = new TSEDataFeed();
    } else {
      console.error('Unknown feed type:', feedType);
      return;
    }
    
    // 创建仪表板
    const dashboardEl = document.querySelector('.dashboard');
    this.dashboard = new Dashboard(
      dashboardEl,
      feed,
      symbol,
      tickSize,
      updateInterval,
      levels,
      aggregation,
      maxSeriesLength,
      scale,
      theme
    );
    
    // 存储数据源
    this.feed = feed;
  }

  clearDashboard() {
    if (this.dashboard) {
      this.dashboard.clearDashboardIntervals();
      this.dashboard = null;
    }
    
    if (this.feed) {
      // 关闭数据源连接
      if (typeof this.feed.close === 'function') {
        this.feed.close();
      }
      this.feed = null;
    }
  }
}
