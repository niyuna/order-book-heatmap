import DashboardManager from './DashboardManager.js';
import BinanceDataFeed from '../lib/BinanceDataFeed.js';
import TSEDataFeed from '../lib/TSEDataFeed.js';

export default class UI {
  constructor() {
    this.dashboardManager = new DashboardManager();
    this.binanceDataFeed = new BinanceDataFeed(); // 创建一个实例用于获取 tickSize
    this.tseDataFeed = new TSEDataFeed(); // 创建一个实例用于获取 tickSize
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
    
    // 获取 feed 选择器的父元素（用于添加 Apply 按钮）
    const feedContainer = document.getElementById('feed-input-row');
    
    // 获取历史数据控件
    const historicalDataWrapper = document.querySelector('.historical-data');
    const startTimeInput = document.getElementById('start-time');
    const endTimeInput = document.getElementById('end-time');
    const loadHistoricalButton = document.getElementById('load-historical-data');
    
    // 设置默认时间范围（过去 1 小时）
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    startTimeInput.value = oneHourAgo.toISOString().slice(0, 16);
    endTimeInput.value = now.toISOString().slice(0, 16);
    
    // 根据 feed 类型显示或隐藏历史数据控件
    const updateHistoricalDataVisibility = () => {
      const feedType = feedSelect.value;
      if (feedType === 'tse') {
        historicalDataWrapper.style.display = '';
      } else {
        historicalDataWrapper.style.display = 'none';
      }
    };
    
    // 初始调用一次
    updateHistoricalDataVisibility();
    
    // 当 feed 类型变化时更新历史数据控件的可见性
    feedSelect.addEventListener('change', updateHistoricalDataVisibility);
    
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
      } else if (feedType === 'tse') {
        // 使用 TSEDataFeed 的 getSymbolTickSize 方法获取 tickSize
        tickSize = this.tseDataFeed.getSymbolTickSize(symbol);
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
    
    // 创建 Apply 按钮
    const applyButton = document.createElement('button');
    applyButton.textContent = 'Apply Settings';
    applyButton.className = 'apply-button';
    applyButton.style.marginLeft = '10px';
    
    // 将 Apply 按钮添加到 feed 选择器的父元素中
    if (feedContainer) {
      feedContainer.appendChild(applyButton);
    } else {
      // 如果找不到 feed 容器，则添加到 UI 栏
      uiBar.appendChild(applyButton);
    }
    
    // 为 Apply 按钮添加点击事件
    applyButton.addEventListener('click', () => {
      // 清除现有仪表板
      this.dashboardManager.clearDashboard();
      
      // 创建新仪表板
      createDashboard();
    });
    
    // 移除输入控件上的 change 事件监听器
    // 现在只有在点击 Apply 按钮时才会应用更改
    
    // 添加加载历史数据的事件监听器
    loadHistoricalButton.addEventListener('click', async () => {
      const feedType = feedSelect.value;
      
      // 只允许 TSE 数据源加载历史数据
      if (feedType !== 'tse') {
        alert('Historical data loading is only available for TSE feed');
        return;
      }
      
      const symbol = tseSymbolInput.value;
      const startTime = new Date(startTimeInput.value).getTime();
      const endTime = new Date(endTimeInput.value).getTime();
      const updateInterval = parseInt(updateIntervalSelect.value);
      
      // 验证输入
      if (isNaN(startTime) || isNaN(endTime)) {
        alert('Please enter valid start and end times');
        return;
      }
      
      if (endTime <= startTime) {
        alert('End time must be greater than start time');
        return;
      }
      
      // 加载历史数据
      try {
        loadHistoricalButton.disabled = true;
        loadHistoricalButton.textContent = 'Loading...';
        
        const success = await this.dashboardManager.dashboard.loadHistoricalData(
          startTime,
          endTime,
          updateInterval
        );
        
        if (!success) {
          alert('Failed to load historical data. Please check the console for details.');
        }
      } catch (error) {
        console.error('Error loading historical data:', error);
        alert('An error occurred while loading historical data');
      } finally {
        loadHistoricalButton.disabled = false;
        loadHistoricalButton.textContent = 'Load';
      }
    });
    
    // 初始创建仪表板
    createDashboard();
  }
}
