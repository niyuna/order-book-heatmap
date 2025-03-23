import DashboardManager from './DashboardManager.js';
import BinanceDataFeed from '../lib/BinanceDataFeed.js';

export default class UI {
  constructor() {
    this.dashboardManager = new DashboardManager();
    this.binanceDataFeed = new BinanceDataFeed(); // 创建一个实例用于获取 tickSize
    this.setupEventListeners();
  }

  setupEventListeners() {
    // 获取 UI 元素
    const uiBar = document.querySelector('.ui');
    
    // 获取所有输入控件
    const updateIntervalSelect = uiBar.querySelector('.update-interval .input');
    const heatmapSizeSelect = uiBar.querySelector('.heatmap-size .input');
    const levelsSelect = uiBar.querySelector('.levels .input');
    const aggregationSelect = uiBar.querySelector('.aggregation .input');
    const scaleSelect = uiBar.querySelector('.scale .input');
    const themeSelect = uiBar.querySelector('.theme .input');
    
    // 获取 feed 和 symbol 选择器
    const feedSelect = document.getElementById('feed');
    const binanceSymbolSelect = document.getElementById('binance-symbol');
    const tseSymbolInput = document.getElementById('tse-symbol');
    
    // 创建仪表板的函数
    const createDashboard = () => {
      // 获取所有选项值
      const feedType = feedSelect.value;
      const symbol = feedType === 'binance' ? binanceSymbolSelect.value : tseSymbolInput.value;
      const updateInterval = parseInt(updateIntervalSelect.value);
      const maxSeriesLength = parseInt(heatmapSizeSelect.value);
      const levels = parseInt(levelsSelect.value);
      const aggregation = parseInt(aggregationSelect.value);
      const scale = scaleSelect.value;
      const theme = themeSelect.value;
      
      // 获取 tickSize
      let tickSize = '0.01'; // 默认值
      if (feedType === 'binance') {
        // 使用 BinanceDataFeed 的 getSymbolTickSize 方法获取 tickSize
        tickSize = this.binanceDataFeed.getSymbolTickSize(symbol);
      }
      
      console.log(`Creating dashboard with symbol: ${symbol}, tickSize: ${tickSize}`);
      
      // 创建仪表板
      this.dashboardManager.createDashboard(
        feedType,
        symbol,
        tickSize,
        updateInterval,
        levels,
        aggregation,
        maxSeriesLength,
        scale,
        theme
      );
    };
    
    // 为所有输入控件添加事件监听器
    const inputControls = [
      updateIntervalSelect, 
      heatmapSizeSelect, 
      levelsSelect, 
      aggregationSelect, 
      scaleSelect, 
      themeSelect,
      feedSelect,
      binanceSymbolSelect,
      tseSymbolInput
    ];
    
    inputControls.forEach(control => {
      if (control) {
        control.addEventListener('change', () => {
          // 清除现有仪表板
          this.dashboardManager.clearDashboard();
          
          // 创建新仪表板
          createDashboard();
        });
      }
    });
    
    // 初始创建仪表板
    createDashboard();
  }
}
