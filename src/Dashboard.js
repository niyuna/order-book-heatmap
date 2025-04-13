import * as PIXI from 'pixi.js';
import { Viewport } from 'pixi-viewport';

import OrderBook from '../lib/BinanceOrderBook.js';
import Tick from '../lib/Tick.js';
import { numCompare } from '../lib/utils.js'; 
import { fmtNum, fmtTime } from '../lib/fmt.js';
import TradesTable from './components/TradesTable.js';
import BarChart from './components/BarChart.js';
import TSEDataFeed from '../lib/TSEDataFeed.js';

export default class Dashboard {
  constructor(el, feed, symbol, tickSize, updateInterval=250, levels=10, aggregation=1, maxSeriesLength=5, scale='linear', theme='rb') {
    // 存储数据源对象
    this.feed = feed;
    this.symbol = symbol;  // 将 symbol 存储为实例变量
    
    // construct the orderbook, also it will init in 2s using remote snapshot
    this.book = new OrderBook(feed, symbol, tickSize, updateInterval);
    this.tick = new Tick(tickSize, aggregation);
    this.el = el;

    this.levels = levels;
    this.aggregation = aggregation;
    this.updateInterval = updateInterval;
    this.intervals = [];

    this.heatmap = {
      // linear vs log2
      scale: scale,
      theme: theme,
      linearScaleCutoff: 0.5,
    };

    this.bufferLevels = 5;
    this.maxSeriesLength = maxSeriesLength;

    // snapshot orderbook
    this.orderbook = [];
    this.maxDepth = 1;

    this.trades = [];
    this.mktBuys = [];
    this.mktSells = [];
    this.mktOrderDeltas = [];

    this.askLine = [];
    this.bidLine = [];

    this.x = [];
    this.y = [];

    // PixiJS applications
    this.heatmapApp = null;
    this.barChartApp = null;
    
    // PixiJS containers
    this.heatmapContainer = null;
    this.heatmapCellsContainer = null;
    this.heatmapDeltasContainer = null;
    this.heatmapAxesContainer = null;
    
    this.barChartContainer = null;
    this.barChartBarsContainer = null;
    this.barChartAxesContainer = null;
    
    // 添加 viewport 相关属性
    this.heatmapViewport = null;
    this.cellMap = new Map(); // 存储单元格对象，避免重复创建
    this.deltaMap = new Map(); // 存储交易点对象
    this.cellSize = { width: 30, height: 20 }; // 默认单元格大小
    
    // 扩展存储容量
    this.extendedMaxSeriesLength = maxSeriesLength * 5; // 存储5倍的数据
    
    // 添加价格定位相关属性
    this.originPrice = null;  // 原点价格
    this.priceStepSize = null;  // 价格步长
    this.priceToYPosition = new Map();  // 价格到Y位置的映射
    
    // 初始化交易表格
    this.tradesTable = new TradesTable(this.el.querySelector('.trades'), this.tick);
    
    // 初始化条形图
    this.barChart = new BarChart(this.el.querySelector('.limit-orders-bar-chart'));
    
    // Setup PixiJS applications
    this.setupPixiApplications();

    // Tooltip element
    if (!window.tooltip) {
      window.tooltip = document.createElement('div');
      window.tooltip.className = 'tooltip';
      window.tooltip.style.opacity = 0;
      window.tooltip.style.position = 'fixed';
      window.tooltip.style.border = 'solid';
      window.tooltip.style.borderWidth = '2px';
      window.tooltip.style.borderRadius = '5px';
      window.tooltip.style.padding = '5px';
      window.tooltip.style.maxWidth = '250px';
      window.tooltip.style.backgroundColor = '#ffffff';
      window.tooltip.style.color = '#000000';
      window.tooltip.style.zIndex = '1000';
      window.tooltip.style.pointerEvents = 'none';
      document.body.appendChild(window.tooltip);
    }

    // 检查是否使用 TSEDataFeed
    const isTSEFeed = feed && feed.constructor.name === 'TSEDataFeed';
    
    if (isTSEFeed) {
      // 如果是 TSEDataFeed，先加载历史数据
      console.log('TSEDataFeed detected, loading historical data before starting regular updates');
      
      // 计算过去 60 分钟的时间范围
      const endTime = Date.now();
      const startTime = endTime - (60 * 60 * 1000); // 60 分钟前
      
      // 检查市场状态
      const marketStatus = feed.isMarketOpen();
      
      // 根据市场状态决定使用的时间范围
      let historyStartTime, historyEndTime;
      
      if (!marketStatus.open) {
        console.log('Market is closed. Using fallback timestamp for historical data.');
        // 使用 fallback 时间戳，并向前推 60 分钟
        historyEndTime = feed.fallbackTimestamp;
        historyStartTime = historyEndTime - (60 * 60 * 1000);
      } else {
        // 市场开放，使用当前时间
        historyStartTime = startTime;
        historyEndTime = endTime;
      }
      
      // 加载历史数据，完成后启动常规更新
      this.loadHistoricalData(historyStartTime, historyEndTime, this.updateInterval, true)
        .then(success => {
          console.log('Historical data loading completed, success:', success);
          // 注意：loadHistoricalData 已经在内部调用了 startRegularUpdates（如果 resumeUpdatesAfterLoad 为 true）
        })
        .catch(error => {
          console.error('Error loading historical data:', error);
          // 即使加载失败，也启动常规更新
          this.startRegularUpdates();
        });
    } else {
      // 不是 TSEDataFeed，直接启动常规更新
      this.startRegularUpdates();
    }
  }

  async setupPixiApplications() {
    console.log('Setting up PixiJS applications');
    
    // 只处理热图，条形图已经由 BarChart 组件处理
    const heatmapEl = this.el.querySelector('.heatmap');
    
    // 清空热图容器
    while (heatmapEl.firstChild) {
      heatmapEl.removeChild(heatmapEl.firstChild);
    }
    
    // 创建热图 PixiJS 应用
    this.heatmapApp = new PIXI.Application();
    await this.heatmapApp.init({
      background: '#000000',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    // 添加热图视图到 DOM
    heatmapEl.appendChild(this.heatmapApp.canvas);
    
    // 阻止滚轮事件引起页面滚动
    heatmapEl.addEventListener('wheel', (event) => {
      event.preventDefault();
    }, { passive: false });
    
    // 设置热图视图样式
    this.heatmapApp.canvas.style.width = '100%';
    this.heatmapApp.canvas.style.height = '100%';
    
    // 创建 Viewport
    this.heatmapViewport = new Viewport({
      screenWidth: this.heatmapApp.screen.width,
      screenHeight: this.heatmapApp.screen.height,
      worldWidth: this.cellSize.width * this.extendedMaxSeriesLength,
      worldHeight: this.cellSize.height * (this.levels * 2),
      events: this.heatmapApp.renderer.events
    });
    
    // 配置 Viewport
    this.heatmapViewport
      .drag({ wheel: false })
      // .pinch()
      .wheel()
      .decelerate()
      .on('moved', () => this.renderHeatmapAxes())
      .on('zoomed', () => this.renderHeatmapAxes())
      .on('moved-end', () => this.renderHeatmapAxes())
      .on('zoomed-end', () => this.renderHeatmapAxes());
    
    // 创建热图容器
    this.heatmapCellsContainer = new PIXI.Container();
    this.heatmapDeltasContainer = new PIXI.Container();
    this.heatmapAxesContainer = new PIXI.Container();
    
    // 添加容器到 Viewport
    this.heatmapViewport.addChild(this.heatmapCellsContainer);
    this.heatmapViewport.addChild(this.heatmapDeltasContainer);
    
    // 添加 Viewport 到舞台
    this.heatmapApp.stage.addChild(this.heatmapViewport);
    
    // 坐标轴容器添加到主舞台，不受 viewport 影响
    this.heatmapApp.stage.addChild(this.heatmapAxesContainer);
    
    // 设置初始大小
    this.resizePixiApplications();
    
    // 处理窗口大小调整
    window.addEventListener('resize', () => this.resizePixiApplications());

    // 设置工具提示的初始位置
    this.updateTooltipPosition();

    // 创建热图单元格的 mesh 和 shader
    this.setupHeatmapMesh();
    console.log('Heatmap mesh setup complete');

    // 创建着色器
    this.createDeltaShader();
    console.log('Shaders created successfully');
  }
  
  resizePixiApplications() {
    const uiBarEl = document.querySelector('.ui');
    const heatmapEl = this.el.querySelector('.heatmap');
    
    // 设置热图大小
    const heatmapWidth = heatmapEl.clientWidth || window.innerWidth * 0.66;
    const heatmapHeight = window.innerHeight - (uiBarEl ? uiBarEl.clientHeight : 0) - 7;
    
    this.heatmapApp.renderer.resize(heatmapWidth, heatmapHeight);
    
    // 更新 Viewport 大小
    this.heatmapViewport.resize(
      heatmapWidth,
      heatmapHeight,
      this.cellSize.width * this.extendedMaxSeriesLength,
      this.cellSize.height * (this.levels * 2)
    );
    
    // 触发条形图的 resize 方法
    if (this.barChart) {
      this.barChart.resize();
    }
    
    // 强制重绘热图（如果有数据）
    if (this.x.length > 0 && this.y.length > 0) {
      this.renderHeatmap();
      this.renderLimitOrdersBarChart();
    }

    // 更新工具提示位置
    this.updateTooltipPosition();
  }

  // restructure & derive secondary metrics from the OrderBook snapshot
  updateDashboard(snapshot, timestamp) {
    // 检查是否使用 fallback 时间戳 - 通过检查订阅状态
    const usingFallback = this.feed && 
                          this.feed.constructor.name === 'TSEDataFeed' && 
                          this.feed.subscriptions && 
                          this.feed.subscriptions.some(sub => sub.usingFallback);
    
    // 确定要使用的时间戳
    let currentTimestamp;
    
    if (timestamp) {
      // 如果提供了明确的时间戳，优先使用它
      currentTimestamp = timestamp;
    } else if (usingFallback && this.feed.subscriptions) {
      // 在 fallback 模式下，使用订阅中的 lastEndTime 作为时间戳
      // 找到第一个使用 fallback 的订阅
      const fallbackSub = this.feed.subscriptions.find(sub => sub.usingFallback);
      if (fallbackSub && fallbackSub.lastEndTime) {
        currentTimestamp = fallbackSub.lastEndTime;
      } else {
        // 如果没有 lastEndTime，使用 fallback 初始时间戳
        currentTimestamp = this.feed.fallbackTimestamp;
      }
    } else {
      // 正常模式下，使用当前时间
      currentTimestamp = Date.now();
    }
    
    // 计算时间戳
    const ts = fmtTime(new Date(currentTimestamp), this.updateInterval);
    
    // 如果使用 fallback 时间戳，添加标记
    if (usingFallback && !this.fallbackLogged) {
      console.log('Using fallback mode with simulated timestamps starting from:', 
                  new Date(this.feed.fallbackTimestamp).toISOString());
      // 只记录一次，避免日志过多
      this.fallbackLogged = true;
    }
    
    // 更新 x 轴（时间戳）
    if (this.x.length === 0 || this.x[this.x.length - 1] !== ts) {
      this.x.push(ts);
      
      // 限制 x 轴数据点数量
      if (this.x.length > this.extendedMaxSeriesLength) {
        this.x.shift();
        console.warn('x axis data points limit reached!');
      }
    }
    
    // 更新 y 轴（价格）
    this.y = [];
    for (let i = 0; i < this.levels + this.bufferLevels; i++) {
      this.y.push(snapshot.aggAskPrices[i]);
      this.y.push(snapshot.aggBidPrices[i]);
    }
    
    // 对价格进行排序（从高到低）
    this.y.sort((a, b) => this.tick.parse(b) - this.tick.parse(a));
    
    // 如果是第一个快照，设置原点价格和价格步长
    if (this.originPrice === null) {
      // 使用中间价格作为原点
      const midIndex = Math.floor(this.y.length / 2);
      this.originPrice = this.tick.parseStep(this.y[midIndex]);
      
      // 使用 tick.js 提供的 stepSize 而不是自己计算
      this.priceStepSize = this.tick.stepSize;
      
      // 初始化价格到Y位置的映射
      this.updatePricePositions();
    }
    
    // 更新订单簿数据
    for (let i = 0; i < this.levels + this.bufferLevels; i++) {
      const askData = {
        value: snapshot.aggAskSizes[i],
        y: snapshot.aggAskPrices[i],
        x: ts,
        type: 'ask',
      };

      const bidData = {
        value: snapshot.aggBidSizes[i],
        y: snapshot.aggBidPrices[i],
        x: ts,
        type: 'bid',
      };
      
      this.orderbook.push(askData);
      this.orderbook.push(bidData);
      
      // 添加新单元格
      // this.addCell(askData);
      // this.addCell(bidData);
      
      // 更新最大深度
      if (snapshot.aggAskSizes[i] > this.maxDepth)
        this.maxDepth = snapshot.aggAskSizes[i];
      if (snapshot.aggBidSizes[i] > this.maxDepth)
        this.maxDepth = snapshot.aggBidSizes[i];
    }

    // 更新价格到Y位置的映射
    this.updatePricePositions();
    
    // 更新其他数据...
    this.ask = snapshot.ask;
    this.bid = snapshot.bid;
    this.askLine.push({
      x: ts,
      y: snapshot.ask
    });
    this.bidLine.push({
      x: ts,
      y: snapshot.bid
    });
    
    if (this.askLine.length > this.extendedMaxSeriesLength) {
      this.askLine.shift();
      this.bidLine.shift();
    }

    // 更新市场买入/卖出数据...
    this.mktBuys.push({
      value: snapshot.stats.mktBuySize,
      count: snapshot.stats.mktBuyOrders,
      vwap: snapshot.stats.avgBuyVWAP,
      x: ts
    });

    this.mktSells.push({
      value: snapshot.stats.mktSellSize,
      count: snapshot.stats.mktSellOrders,
      vwap: snapshot.stats.avgSellVWAP,
      x: ts
    });

    const sizeDelta = snapshot.stats.mktBuySize - snapshot.stats.mktSellSize;
    const totalTradedSize = snapshot.stats.mktBuySize + snapshot.stats.mktSellSize;
    let delta = {
      x: ts,
      value: Math.abs(snapshot.stats.mktBuySize - snapshot.stats.mktSellSize),
      totalSize: this.tick.round(totalTradedSize),
    };

    // 工具提示消息
    delta.msgHTML = `${delta.totalSize} contracts traded<br/>`;
    delta.msgHTML = `${delta.msgHTML}${snapshot.stats.mktBuySize} contracts bought (${snapshot.stats.mktBuyOrders}) orders<br/>`;
    delta.msgHTML = `${delta.msgHTML}${snapshot.stats.mktSellSize} contracts sold (${snapshot.stats.mktSellOrders}) orders`;

    if (sizeDelta > 0) {
      delta.y = snapshot.stats.avgBuyVWAP;
      delta.type = 'bid';
    } else {
      delta.y = snapshot.stats.avgSellVWAP;
      delta.type = 'ask';
    }

    this.mktOrderDeltas.push(delta);

    // 添加新的增量点
    // this.addDelta(delta);

    if (this.mktBuys.length > this.extendedMaxSeriesLength) {
      this.mktBuys.shift();
      this.mktSells.shift();
      this.mktOrderDeltas.shift();
    }

    // 更新交易
    this.trades = this.trades.concat(snapshot.trades);
    if (this.trades.length > this.extendedMaxSeriesLength)
      this.trades = this.trades.slice(this.trades.length - this.extendedMaxSeriesLength);

    const sortedTrades = this.trades
      .map(trade => trade.size)
      .sort((a, b) => a - b);
    const top10PercentileIndex = Math.floor(sortedTrades.length - 1 - sortedTrades.length / 10);
    this.topTradeSize = sortedTrades[top10PercentileIndex] || 0;
    
  }

  // 更新价格到Y位置的映射
  updatePricePositions() {
    this.priceToYPosition.clear();
    
    for (const price of this.y) {
      const priceDiff = this.tick.parseStep(price) - this.originPrice;
      const yPosition = -priceDiff / this.priceStepSize;  // 负号是因为价格越高，y坐标越小
      this.priceToYPosition.set(price, yPosition);
    }
  }
  
  // 同样修改 addDelta 方法，使用价格差值计算Y位置
  addDelta(delta) {
    const xIndex = this.x.indexOf(delta.x);
    if (xIndex === -1) return;
    
    // 使用价格到Y位置的映射获取Y位置
    const yPosition = this.priceToYPosition.get(delta.y);
    if (yPosition === undefined) return;
    
    const key = `delta-${delta.x}-${delta.y}`;
    let circle = this.deltaMap.get(key);
    
    if (!circle) {
      circle = new PIXI.Graphics();
      this.heatmapDeltasContainer.addChild(circle);
      this.deltaMap.set(key, circle);
    }
    
    // 计算半径和颜色
    const maxTradedSize = Math.max(...this.mktOrderDeltas.map(x => x.totalSize), 1);
    const radius = this.getDeltaDotRadius(delta.totalSize, this.cellSize.height, maxTradedSize);
    
    const sDeltaValues = this.mktOrderDeltas.map(x => x.value).sort(numCompare);
    const factor = sDeltaValues.length > 1 ? 
      (delta.value - sDeltaValues[0]) / (sDeltaValues[sDeltaValues.length - 1] - sDeltaValues[0]) : 
      0.5;
    
    // 设置颜色范围
    const colorRange = delta.type === 'ask' ? ["#ff9100", "#fff400"] : ["#00d7ff", "#56fffa"];
    const hexColor = this.interpolateColor(colorRange[0], colorRange[1], factor);
    const color = parseInt(hexColor.replace('#', '0x'));
    const hoverColor = delta.type === 'ask' ? 0xff0000 : 0x00aaff;
    
    // 更新增量点
    circle.clear();
    circle.beginFill(color);
    circle.drawCircle(
      (xIndex + 0.5) * this.cellSize.width,
      ((yPosition + this.levels) + 0.5) * this.cellSize.height,
      radius
    );
    circle.endFill();
    
    // 使圆点可交互
    circle.eventMode = 'static';
    
    // 存储圆点相关数据
    circle.deltaData = delta;
    circle.originalColor = color;
    circle.hoverColor = hoverColor;
    circle.centerX = (xIndex + 0.5) * this.cellSize.width;
    circle.centerY = ((yPosition + this.levels) + 0.5) * this.cellSize.height;
    circle.radius = radius;
    
    // 添加鼠标悬停事件
    circle.on('pointerover', (event) => {
      // 高亮显示圆点
      circle.clear();
      circle.beginFill(circle.hoverColor);
      circle.drawCircle(circle.centerX, circle.centerY, circle.radius);
      circle.endFill();
      
      // 显示工具提示
      window.tooltip.style.opacity = 1;
      window.tooltip.innerHTML = delta.msgHTML;
      
      // 使用固定位置，不再跟随鼠标
      // 不需要更新位置，因为已经在右上角固定了
      
      window.tooltip.style.backgroundColor = delta.type === 'ask' ? '#faeaea' : '#eafaea';
      window.tooltip.style.borderColor = delta.type === 'ask' ? 'red' : 'green';
    });
    
    // 添加鼠标移出事件
    circle.on('pointerout', () => {
      // 恢复圆点原始颜色
      circle.clear();
      circle.beginFill(circle.originalColor);
      circle.drawCircle(circle.centerX, circle.centerY, circle.radius);
      circle.endFill();
      
      // 隐藏工具提示
      window.tooltip.style.opacity = 0;
    });
  }
  
  renderHeatmap() {
    // 渲染坐标轴
    this.renderHeatmapAxes();

    // 更新单元格数据
    this.updateHeatmapCellsData();
    
    // 更新交易点数据
    this.updateDeltasData();
  }
  
  renderHeatmapAxes() {
    // 清除现有的坐标轴
    this.heatmapAxesContainer.removeChildren();
    
    // 创建文本样式
    const textStyle = new PIXI.TextStyle({
      fontFamily: 'Arial',
      fontSize: 10,
      fill: '#ffffff',
    });
    
    // 获取可见区域
    const visibleBounds = this.heatmapViewport.getVisibleBounds();
    const startX = Math.floor(visibleBounds.x / this.cellSize.width);
    const endX = Math.ceil((visibleBounds.x + visibleBounds.width) / this.cellSize.width);
    
    // 计算可见的价格范围
    const startWorldY = visibleBounds.y;
    const endWorldY = visibleBounds.y + visibleBounds.height;
    
    // 绘制 x 轴
    const xAxis = new PIXI.Graphics();
    xAxis.lineStyle(1, 0x666666);
    xAxis.moveTo(0, this.heatmapApp.screen.height - 20);
    xAxis.lineTo(this.heatmapApp.screen.width, this.heatmapApp.screen.height - 20);
    this.heatmapAxesContainer.addChild(xAxis);
    
    // 绘制 x 轴标签
    const xLabelPeriod = Math.ceil((endX - startX) / 10);
    for (let i = startX; i < endX; i += xLabelPeriod) {
      if (i >= 0 && i < this.x.length) {
        const worldX = i * this.cellSize.width;
        const screenX = this.heatmapViewport.toScreen(worldX, 0).x;
        
        const label = new PIXI.Text(this.x[i], textStyle);
        label.anchor.set(0.5, 0);
        label.position.set(screenX, this.heatmapApp.screen.height - 15);
        this.heatmapAxesContainer.addChild(label);
      }
    }
    
    // 增加右侧边距，为 y 轴标签留出更多空间
    const rightMargin = 50;
    
    // 绘制 y 轴（右侧）
    const yAxisRight = new PIXI.Graphics();
    yAxisRight.lineStyle(1, 0x666666);
    yAxisRight.moveTo(this.heatmapApp.screen.width - rightMargin, 0);
    yAxisRight.lineTo(this.heatmapApp.screen.width - rightMargin, this.heatmapApp.screen.height);
    this.heatmapAxesContainer.addChild(yAxisRight);
    
    // 绘制 y 轴标签（右侧）
    // 使用价格步长计算标签间隔
    const cellsInView = (endWorldY - startWorldY) / this.cellSize.height;
    const yLabelCount = Math.min(10, cellsInView); // 最多显示10个标签
    const yLabelInterval = this.cellSize.height * Math.ceil(cellsInView / yLabelCount);
    
    // 计算起始位置（对齐到单元格网格）
    const startYAligned = Math.floor(startWorldY / this.cellSize.height) * this.cellSize.height;
    
    // 绘制标签
    for (let worldY = startYAligned; worldY < endWorldY; worldY += yLabelInterval) {
      // 将世界坐标转换为价格
      // 注意：worldY = (yPosition + this.levels) * this.cellSize.height
      // 所以 yPosition = worldY / this.cellSize.height - this.levels
      const yPosition = worldY / this.cellSize.height - this.levels;
      
      // 从 yPosition 计算价格
      const priceDiff = -yPosition * this.priceStepSize; // 负号是因为在 updatePricePositions 中使用了负号
      const price = this.originPrice + priceDiff;
      
      // 格式化价格
      const formattedPrice = this.tick.parse(price);
      
      // 转换为屏幕坐标
      const screenY = this.heatmapViewport.toScreen(0, worldY).y;
      
      // 创建标签
      const label = new PIXI.Text(formattedPrice, textStyle);
      label.anchor.set(0, 0.5);
      label.position.set(this.heatmapApp.screen.width - rightMargin + 5, screenY);
      this.heatmapAxesContainer.addChild(label);
    }
  }
  
  interpolateColor(color1, color2, factor) {
    const r1 = parseInt(color1.substring(1, 3), 16);
    const g1 = parseInt(color1.substring(3, 5), 16);
    const b1 = parseInt(color1.substring(5, 7), 16);
    
    const r2 = parseInt(color2.substring(1, 3), 16);
    const g2 = parseInt(color2.substring(3, 5), 16);
    const b2 = parseInt(color2.substring(5, 7), 16);
    
    const r = Math.round(r1 + factor * (r2 - r1));
    const g = Math.round(g1 + factor * (g2 - g1));
    const b = Math.round(b1 + factor * (b2 - b1));
    
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  renderTimeAndSales() {
    // 使用 TradesTable 组件更新交易表格
    this.tradesTable.update(this.trades, this.topTradeSize);
  }

  renderLimitOrdersBarChart() {
    // 准备数据
    let askLevels = [];
    let bidLevels = [];

    for (let l = this.orderbook.length - 1; l > 0; l--) {
      const lvl = this.orderbook[l];
      if (lvl.x !== this.x[this.x.length - 1])
        break;

      if (this.y.indexOf(lvl.y) === -1)
        continue;

      if (lvl.type === 'ask')
          askLevels.push(lvl);

      if (lvl.type === 'bid')
          bidLevels.push(lvl);
    }

    // 对价格从低到高排序，用于 x 轴
    const sortedPrices = [...this.y].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    // 使用 BarChart 组件渲染条形图
    this.barChart.render(askLevels, bidLevels, sortedPrices);
  }

  //logarithmically scale delta dot size
  getDeltaDotRadius(size, vertBandwidth, maxTradedSize) {
    const maxMultiplier = 1;
    let baseMultiplier = 0.25;

    if (0) {
      baseMultiplier += (Math.log2(size) / Math.log2(maxTradedSize)) * maxMultiplier;
    } else {
      baseMultiplier += (size / maxTradedSize) * maxMultiplier;
    }
    return vertBandwidth * baseMultiplier;
  }

  // 启动常规更新
  startRegularUpdates() {
    // 清除现有的更新间隔
    this.clearDashboardIntervals();
    
    // 设置新的更新间隔
    let rerenderInterval = setInterval(() => {
      const snapshot = this.book.getSnapshot(this.levels + this.bufferLevels, this.aggregation);

      if (snapshot) {
        this.updateDashboard(snapshot);
        this.renderTimeAndSales();
        this.renderHeatmap();
        this.renderLimitOrdersBarChart();
      }
    }, this.updateInterval);
    
    this.intervals.push(rerenderInterval);
    console.log('Started regular dashboard updates');
  }

  /**
   * 清除仪表板定时器
   */
  clearDashboardIntervals() {
    // 清除所有定时器
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
    console.log('Cleared all dashboard intervals');
  }

  // 修改 updateTooltipPosition 方法
  updateTooltipPosition() {
    const heatmapEl = this.el.querySelector('.heatmap-wrapper');
    
    // 确保热图元素存在
    if (!heatmapEl) return;
    
    // 获取热图元素的位置和尺寸
    const rect = heatmapEl.getBoundingClientRect();
    
    // 确保获取到了有效的位置
    if (rect.width === 0 || rect.height === 0) return;
    
    // 设置工具提示在热图右上角
    // 使用 position: fixed 可以相对于视口定位，避免滚动问题
    window.tooltip.style.position = 'fixed';
    window.tooltip.style.left = (rect.left + rect.width + 50) + 'px'; // 距离右边缘 260px
    window.tooltip.style.top = (rect.top + 10) + 'px'; // 距离顶部 10px
    
    // 确保工具提示不会超出视口
    const tooltipWidth = 250; // 工具提示的最大宽度
    const rightEdge = rect.left + rect.width - 10;
    const leftPosition = Math.max(10, Math.min(rightEdge - tooltipWidth, rightEdge - 10));
    
    window.tooltip.style.left = leftPosition + 'px';
    
    // 调试信息
    console.log('Heatmap rect:', rect);
    console.log('Tooltip position:', { left: window.tooltip.style.left, top: window.tooltip.style.top });
  }

  /**
   * 加载历史数据
   * @param {number} startTime - 开始时间戳
   * @param {number} endTime - 结束时间戳
   * @param {number} updateInterval - 更新间隔（毫秒）
   * @param {boolean} resumeUpdatesAfterLoad - 加载完成后是否恢复更新
   * @returns {Promise<boolean>} - 加载完成的 Promise
   */
  async loadHistoricalData(startTime, endTime, updateInterval = this.updateInterval, resumeUpdatesAfterLoad = false) {
    try {
      // 检查数据源类型
      if (!(this.feed instanceof TSEDataFeed)) {
        console.error('Historical data loading is only supported for TSE feed');
        return false;
      }
      
      // 显示加载指示器
      this.showLoadingIndicator();
      
      // 停止自动更新
      this.clearDashboardIntervals();
      console.log('Stopped automatic updates for historical data view');
      
      // 获取历史数据 - 使用实例变量 this.symbol
      const historicalData = await this.feed.getHistoricalData(
        this.symbol,  // 使用存储的 symbol
        startTime,
        endTime,
        updateInterval
      );
      
      // 清除现有数据
      this.clearData();
      
      // 重置 OrderBook
      this.book.reset();
      
      // 处理历史数据
      if (historicalData.heatmapData.length > 0) {
        // 首先处理第一个快照，以便设置初始价格
        const firstDataPoint = historicalData.heatmapData[0];
        
        // 更新 OrderBook
        this.book.updateOrderBook(firstDataPoint.snapshot);
        
        // 获取 OrderBook 快照
        const firstSnapshot = this.book.getSnapshot(this.levels + this.bufferLevels, this.aggregation);
        
        // 更新 originPrice 为第一个快照的价格中点
        if (firstSnapshot && firstSnapshot.aggAskSizes.length > 0 && firstSnapshot.aggBidSizes.length > 0) {
          
          // 计算中点价格并使用 tick.round 方法进行四舍五入
          const midPrice = this.tick.roundStep((firstSnapshot.ask + firstSnapshot.bid) / 2);
          
          // 重置 originPrice
          this.originPrice = midPrice;
          console.log(`Reset originPrice to ${midPrice} based on first historical snapshot`);
          this.priceStepSize = this.tick.stepSize;
          
          // 重新计算价格位置映射
          this.updatePricePositions();
        }
        
        // 使用 OrderBook 处理后的数据更新仪表板
        this.updateDashboard(firstSnapshot, firstDataPoint.timestamp);
        
        // 处理剩余的历史数据
        for (let i = 1; i < historicalData.heatmapData.length; i++) {
          const dataPoint = historicalData.heatmapData[i];
          
          // 更新 OrderBook
          this.book.updateOrderBook(dataPoint.snapshot);
          
          // 获取 OrderBook 快照
          const snapshot = this.book.getSnapshot(this.levels + this.bufferLevels, this.aggregation);
          
          // 使用 OrderBook 处理后的数据更新仪表板
          this.updateDashboard(snapshot, dataPoint.timestamp);
        }
        
        // 处理交易数据
        if (historicalData.tradesData.length > 0) {
          // 获取最后一个热图数据点的时间戳
          const lastTimestamp = historicalData.heatmapData[historicalData.heatmapData.length - 1].timestamp;
          
          // 筛选最后一个时间间隔的交易数据
          const lastIntervalTrades = historicalData.tradesData.filter(trade => 
            trade.time >= lastTimestamp && trade.time < lastTimestamp + updateInterval
          );
          
          // 更新交易数据
          for (const trade of historicalData.tradesData) {
            this.book.updateTrade(trade);
          }
          
          console.log(`Loaded ${historicalData.tradesData.length} trades from historical data`);
        }
      }
      
      // 更新视图
      this.renderTimeAndSales();
      this.renderHeatmap();
      this.renderLimitOrdersBarChart();
      
      // 如果需要恢复更新，启动常规更新
      if (resumeUpdatesAfterLoad) {
        this.startRegularUpdates();
      } else {
        // 添加一个提示，告诉用户如何恢复实时数据
        console.log('Historical data loaded. To resume real-time updates, call dashboard.startRegularUpdates()');
      }
      
      // 隐藏加载指示器
      this.hideLoadingIndicator();
      
      return true;
    } catch (error) {
      console.error('Error loading historical data:', error);
      
      // 如果需要恢复更新，启动常规更新
      if (resumeUpdatesAfterLoad) {
        this.startRegularUpdates();
      }
      
      // 隐藏加载指示器
      this.hideLoadingIndicator();
      
      return false;
    }
  }

  // 清除数据的辅助方法
  clearData() {
    this.orderbook = [];
    this.trades = [];
    this.mktBuys = [];
    this.mktSells = [];
    this.mktOrderDeltas = [];
    this.askLine = [];
    this.bidLine = [];
    this.x = [];
    this.y = [];
    
    // 清除热图单元格和增量点
    if (this.cellMap) {
      this.cellMap.forEach(cell => cell.destroy());
      this.cellMap.clear();
    }
    
    if (this.deltaMap) {
      this.deltaMap.forEach(delta => delta.destroy());
      this.deltaMap.clear();
    }
    
    // 清除容器
    if (this.heatmapCellsContainer) {
      this.heatmapCellsContainer.removeChildren();
    }
    
    if (this.heatmapDeltasContainer) {
      this.heatmapDeltasContainer.removeChildren();
    }

    // 清空单元格数据
    this.cellsData = [];
    
    // 移除现有的 mesh
    if (this.cellMesh) {
      this.heatmapCellsContainer.removeChild(this.cellMesh);
      this.cellMesh = null;
    }
    
    // 创建新的空 mesh
    // this.createEmptyMesh();
  }

  // 加载指示器方法
  showLoadingIndicator() {
    if (!this.loadingIndicator) {
      this.loadingIndicator = document.createElement('div');
      this.loadingIndicator.className = 'loading-indicator';
      this.loadingIndicator.innerHTML = 'Loading historical data...';
      this.loadingIndicator.style.position = 'absolute';
      this.loadingIndicator.style.top = '50%';
      this.loadingIndicator.style.left = '50%';
      this.loadingIndicator.style.transform = 'translate(-50%, -50%)';
      this.loadingIndicator.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
      this.loadingIndicator.style.color = 'white';
      this.loadingIndicator.style.padding = '20px';
      this.loadingIndicator.style.borderRadius = '5px';
      this.loadingIndicator.style.zIndex = '1000';
      this.el.appendChild(this.loadingIndicator);
    } else {
      this.loadingIndicator.style.display = 'block';
    }
  }

  hideLoadingIndicator() {
    if (this.loadingIndicator) {
      this.loadingIndicator.style.display = 'none';
    }
  }

  // 设置热图 mesh 和 shader
  setupHeatmapMesh() {
    // 创建单元格数据数组
    this.cellsData = [];
    
    // 创建自定义着色器
    const vertex = `
      precision highp float;
      
      attribute vec2 aVertexPosition;
      attribute vec4 aColor;
      
      uniform mat3 uProjectionMatrix;
      uniform mat3 uWorldTransformMatrix;
      uniform mat3 uTransformMatrix;
      
      varying vec4 vColor;
      
      void main() {
        mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
        vec3 position = mvp * vec3(aVertexPosition, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
        vColor = aColor;
      }
    `;
    
    const fragment = `
      precision highp float;
      
      varying vec4 vColor;
      
      void main() {
        gl_FragColor = vColor;
      }
    `;
    
    // 创建着色器
    this.cellShader = PIXI.Shader.from({gl: {vertex, fragment}, resources: {}});
    
    console.log('Shader created successfully');
  }

  // use cellsdata to render heatmap cells
  updateCellGeometry() {
    console.log('Updating cell geometry');
    // console.log(this.cellsData);
    
    if (this.cellsData.length === 0) {
      console.log('No cell data to render');
      return;
    }
    
    // 创建顶点和颜色数组
    const vertices = [];
    const colors = [];
    const indices = [];
    
    // 遍历所有单元格数据
    for (let i = 0; i < this.cellsData.length; i++) {
      const cellData = this.cellsData[i];
      const { x, y, width, height, color } = cellData;
      
      // 计算顶点索引
      const baseIndex = i * 4;
      
      // 添加顶点
      vertices.push(
        x, y,                 // 左上
        x + width, y,         // 右上
        x, y + height,        // 左下
        x + width, y + height // 右下
      );
      
      // 添加颜色 (RGBA)
      const r = ((color >> 16) & 0xFF) / 255;
      const g = ((color >> 8) & 0xFF) / 255;
      const b = (color & 0xFF) / 255;
      const a = 1.0; // 完全不透明
      
      for (let j = 0; j < 4; j++) {
        colors.push(r, g, b, a);
      }
      
      // 添加索引 (两个三角形组成一个矩形)
      indices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,     // 第一个三角形
        baseIndex + 1, baseIndex + 3, baseIndex + 2  // 第二个三角形
      );
    }
    
    console.log(`Generated geometry: ${vertices.length/2} vertices, ${indices.length/3} triangles`);
    
    // 更新几何体
    if (this.cellMesh) {
      this.heatmapCellsContainer.removeChild(this.cellMesh);
      this.cellMesh.destroy(true);
    }
    
    // 创建新的几何体
    const newGeometry = new PIXI.Geometry({
      attributes: {
        aVertexPosition: new Float32Array(vertices),
        aColor: new Float32Array(colors)
      },
      // indexBuffer: new Uint16Array(indices)
      indexBuffer: indices
    });
    
    // 创建新的 mesh
    this.cellMesh = new PIXI.Mesh({
      geometry: newGeometry,
      shader: this.cellShader
    });
    
    // 添加 mesh 到热图容器
    this.heatmapCellsContainer.addChild(this.cellMesh);
    console.log('New mesh created and added to container');
  }

  // 获取单元格颜色
  getCellColor(cell) {
    if (cell.value <= 0) return 0x000000; // 黑色表示空单元格
    
    let factor;
    if (this.heatmap.scale === 'log2') {
      factor = Math.log(cell.value + 1) / Math.log2(this.maxDepth || 1);
    } else {
      factor = cell.value / (this.heatmap.linearScaleCutoff * (this.maxDepth || 1));
    }
    factor = Math.min(1, Math.max(0, factor)); // 限制在 0 到 1 之间
    
    // 设置颜色范围
    let colorRange;
    if (this.heatmap.theme === 'bw') {
      colorRange = cell.type === 'bid' ? ["#222222", "#ffffff"] : ["#222222", "#ffffff"];
    } else {
      colorRange = cell.type === 'bid' ? ["#073247", "#00aaff"] : ["#2e0704", "#ff0000"];
    }
    
    // 插值颜色
    const hexColor = this.interpolateColor(colorRange[0], colorRange[1], factor);
    return parseInt(hexColor.replace('#', '0x'));
  }

  // update heatmap cells data from order book, then trigger a render
  updateHeatmapCellsData() {
    // 清空单元格数据
    this.cellsData = [];
    
    console.log('Updating heatmap cells data');
    console.log('Orderbook length:', this.orderbook.length);
    
    // 遍历所有单元格数据
    for (let i = 0; i < this.orderbook.length; i++) {
      const cell = this.orderbook[i];
      
      // 获取单元格的 x 索引
      const xIndex = this.x.indexOf(cell.x);
      
      // 如果 x 索引无效，则跳过
      if (xIndex === -1) {
        console.warn('Invalid cell x index:', cell.x);
        continue;
      }
      
      // 计算 x 坐标
      const worldX = xIndex * this.cellSize.width;
      
      // 计算 y 坐标 - 使用价格差值
      // 首先，计算价格与原点价格的差值
      const priceDiff = this.tick.roundStep(cell.y) - this.originPrice;
      
      // 然后，将价格差值转换为位置
      // 注意：价格越高，y 坐标越小（屏幕坐标系中 y 轴向下）
      const yPosition = -priceDiff / this.priceStepSize;
      
      // 最后，计算世界坐标
      const worldY = (yPosition + this.levels) * this.cellSize.height;
      
      // 计算单元格颜色
      const color = this.getCellColor(cell);
      
      // 添加单元格数据
      this.cellsData.push({
        x: worldX,
        y: worldY,
        width: this.cellSize.width,
        height: this.cellSize.height,
        color: color,
        cell: cell
      });
    }
    
    console.log('Cell data length:', this.cellsData.length);
    
    // 更新几何体
    this.updateCellGeometry();
    
  }

  /**
   * 创建 Delta 渲染所需的着色器
   */
  createDeltaShader() {
    console.log('Creating delta shader');
    
    // 顶点着色器
    const vertex = `
      precision highp float;
      
      attribute vec2 aVertexPosition;
      attribute vec4 aColor;
      attribute float aRadius;
      
      uniform mat3 uProjectionMatrix;
      uniform mat3 uWorldTransformMatrix;
      uniform mat3 uTransformMatrix;
      
      varying vec4 vColor;
      varying vec2 vPosition;
      varying float vRadius;
      
      void main() {
        mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
        vec3 position = mvp * vec3(aVertexPosition, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
        vColor = aColor;
        vPosition = aVertexPosition;
        vRadius = aRadius;
        gl_PointSize = aRadius * 2.0;
      }
    `;
    
    // 片段着色器
    const fragment = `
      precision highp float;
      
      varying vec4 vColor;
      varying vec2 vPosition;
      varying float vRadius;
      
      void main() {
        // 计算当前片段到中心的距离
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        
        // 如果距离大于0.5，则丢弃片段（创建圆形）
        if (dist > 0.5) {
          discard;
        }
        
        // 应用颜色
        gl_FragColor = vColor;
      }
    `;
    
    // 创建着色器
    this.deltaShader = PIXI.Shader.from({gl: {vertex, fragment}, resources: {}});
    
    console.log('Delta shader created successfully');
  }

  /**
   * 更新交易点数据
   */
  updateDeltasData() {
    // 清空交易点数据
    this.deltasData = [];
    
    console.log('Updating deltas data');
    console.log('Trades length:', this.trades.length);
    
    // 遍历所有交易
    for (let i = 0; i < this.trades.length; i++) {
      const trade = this.trades[i];
      
      // 获取交易时间并规范化
      const tradeTimestamp = trade.timestamp || Date.now();
      const normalizedTime = fmtTime(tradeTimestamp, this.updateInterval);
      
      // 直接查找规范化时间在 x 轴上的索引
      const xIndex = this.x.indexOf(normalizedTime);
      
      // 如果找不到匹配的索引，则跳过
      if (xIndex === -1) {
        console.warn('Normalized time not found in x-axis:', normalizedTime);
        continue;
      }
      
      // 计算 x 坐标，使用插值获取更精确的位置
      let worldX;
      
      // 如果有原始时间戳，使用它来计算更精确的位置
      if (tradeTimestamp) {
        // 获取当前格子的时间范围
        const currentTime = this.x[xIndex];
        const nextTime = (xIndex < this.x.length - 1) ? this.x[xIndex + 1] : currentTime + this.updateInterval;
        
        // 计算原始时间戳在格子内的相对位置（0-1之间）
        const timeRange = nextTime - currentTime;
        const relativePosition = timeRange > 0 ? 
          Math.min(1, Math.max(0, (tradeTimestamp - currentTime) / timeRange)) : 0.5;
        
        // 计算精确的 x 坐标
        const cellLeft = xIndex * this.cellSize.width;
        worldX = cellLeft + relativePosition * this.cellSize.width;
      } else {
        // 如果没有原始时间戳，使用格子中心
        worldX = xIndex * this.cellSize.width + this.cellSize.width / 2;
      }
      
      // 计算 y 坐标 - 使用价格差值
      const priceDiff = this.tick.roundStep(trade.price) - this.originPrice;
      const yPosition = -priceDiff / this.priceStepSize;
      const worldY = (yPosition + this.levels) * this.cellSize.height + this.cellSize.height / 2;
      
      // 计算交易点颜色和大小
      const color = trade.isBuyerMaker ? 0xFF0000 : 0x00FF00; // 红色表示卖，绿色表示买
      const quantity = trade.quantity || trade.size || 1; // 兼容不同的数量字段名
      const radius = Math.min(5, Math.max(2, Math.sqrt(quantity) * 0.5)); // 根据数量调整大小
      
      // 添加交易点数据
      this.deltasData.push({
        x: worldX,
        y: worldY,
        radius: radius,
        color: color,
        trade: trade,
        normalizedTime: normalizedTime // 存储规范化后的时间，便于调试
      });
    }
    
    console.log('Deltas data length:', this.deltasData.length);
    
    // 更新几何体
    this.updateDeltaGeometry();
  }

  /**
   * 更新交易点几何体
   */
  updateDeltaGeometry() {
    console.log('Updating delta geometry');
    
    if (this.deltasData.length === 0) {
      console.log('No delta data to render');
      return;
    }
    
    // 创建顶点、颜色和半径数组
    const vertices = [];
    const colors = [];
    const radii = [];
    
    // 遍历所有交易点数据
    for (let i = 0; i < this.deltasData.length; i++) {
      const deltaData = this.deltasData[i];
      const { x, y, radius, color } = deltaData;
      
      // 添加顶点
      vertices.push(x, y);
      
      // 添加颜色 (RGBA)
      const r = ((color >> 16) & 0xFF) / 255;
      const g = ((color >> 8) & 0xFF) / 255;
      const b = (color & 0xFF) / 255;
      const a = 1.0; // 完全不透明
      
      colors.push(r, g, b, a);
      
      // 添加半径
      radii.push(radius);
    }
    
    console.log(`Generated delta geometry: ${vertices.length/2} points`);
    
    // 更新几何体
    if (this.deltaMesh) {
      this.heatmapDeltasContainer.removeChild(this.deltaMesh);
      this.deltaMesh.destroy(true);
    }
    
    // 创建新的几何体
    const newGeometry = new PIXI.Geometry({
      attributes: {
        aVertexPosition: new Float32Array(vertices),
        aColor: new Float32Array(colors),
        aRadius: new Float32Array(radii)
      }
    });
    
    // 创建新的 mesh
    this.deltaMesh = new PIXI.Mesh({
      geometry: newGeometry,
      shader: this.deltaShader,
      drawMode: PIXI.DRAW_MODES.POINTS
    });
    
    // 添加 mesh 到交易点容器
    this.heatmapDeltasContainer.addChild(this.deltaMesh);
    console.log('New delta mesh created and added to container');
  }

  /**
   * 销毁仪表板
   */
  destroy() {
    // 清除所有定时器
    this.clearDashboardIntervals();
    
    // 销毁 OrderBook
    if (this.book && this.book.subscription) {
      this.book.subscription.unsubscribe();
    }
    
    // 销毁 PixiJS 应用
    if (this.heatmapApp) {
      this.heatmapApp.destroy(true, { children: true, texture: true, baseTexture: true });
    }
    
    if (this.barChartApp) {
      this.barChartApp.destroy(true, { children: true, texture: true, baseTexture: true });
    }
    
    // 清空 DOM 元素
    if (this.el) {
      this.el.innerHTML = '';
    }
    
    console.log('Dashboard destroyed');
  }
}