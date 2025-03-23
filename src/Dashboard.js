import * as PIXI from 'pixi.js';
import { Viewport } from 'pixi-viewport';

import DataFeed from '../lib/BinanceDataFeed.js';
import OrderBook from '../lib/BinanceOrderBook.js';
import Tick from '../lib/Tick.js';
import { numCompare } from '../lib/utils.js'; 
import { fmtNum, fmtTime } from '../lib/fmt.js';
import TradesTable from './components/TradesTable.js';

export default class Dashboard {
  constructor(el, feed, symbol, tickSize, updateInterval=250, levels=10, aggregation=1, maxSeriesLength=5, scale='linear', theme='rb') {
    // construct the orderbook, also it will init in 2s using remote snapshot
    this.book = new OrderBook(feed, symbol, tickSize);
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
    
    // Setup PixiJS applications
    this.setupPixiApplications();

    // Tooltip element
    if (!window.tooltip) {
      window.tooltip = document.createElement('div');
      window.tooltip.className = 'tooltip';
      window.tooltip.style.opacity = 0;
      window.tooltip.style.position = 'absolute';
      window.tooltip.style.border = 'solid';
      window.tooltip.style.borderWidth = '2px';
      window.tooltip.style.borderRadius = '5px';
      window.tooltip.style.padding = '5px';
      document.body.appendChild(window.tooltip);
    }

    // get recent market snapshot & rerender
    let rerenderInterval = setInterval(() => {
      const snapshot = this.book.getSnapshot(levels + this.bufferLevels, aggregation);

      if (snapshot) {
        this.updateDashboard(snapshot);
        this.renderTimeAndSales();
        this.renderHeatmap();
        this.renderLimitOrdersBarChart();
      }
    }, updateInterval);
    this.intervals.push(rerenderInterval);

    // recalculate order book intensity every 2 seconds
    // let recalculateDepth = setInterval(() => {
    //   let maxDepth = 0;
    //   for (let i = 0, l = this.orderbook.length; i < l; i++) {
    //     if (this.orderbook[i].value > maxDepth)
    //       maxDepth = this.orderbook[i].value;
    //   }

    //   this.maxDepth = maxDepth;
    // }, 2000);
    // this.intervals.push(recalculateDepth);

    // Add event listeners for interactions
    // this.setupEventListeners();
  }

  async setupPixiApplications() {
    // Remove any existing elements
    const heatmapEl = this.el.querySelector('.heatmap');
    const barChartEl = this.el.querySelector('.limit-orders-bar-chart');
    
    // Remove existing canvas or SVG elements
    while (heatmapEl.firstChild) {
      heatmapEl.removeChild(heatmapEl.firstChild);
    }
    
    while (barChartEl.firstChild) {
      barChartEl.removeChild(barChartEl.firstChild);
    }
    
    // Create PixiJS applications
    this.heatmapApp = new PIXI.Application();
    await this.heatmapApp.init({
      background: '#000000',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    this.barChartApp = new PIXI.Application();
    await this.barChartApp.init({
      background: '#000000',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    // Add PixiJS views to DOM
    heatmapEl.appendChild(this.heatmapApp.canvas);
    barChartEl.appendChild(this.barChartApp.canvas);
    
    heatmapEl.addEventListener('wheel', (event) => {
      // 阻止默认的滚动行为
      event.preventDefault();
    }, { passive: false });
    barChartEl.addEventListener('wheel', (event) => {
      // 阻止默认的滚动行为
      event.preventDefault();
    }, { passive: false });

    // Set view styles
    this.heatmapApp.canvas.style.width = '100%';
    this.heatmapApp.canvas.style.height = '100%';
    this.barChartApp.canvas.style.width = '100%';
    this.barChartApp.canvas.style.height = '100%';
    
    // 创建 Viewport
    this.heatmapViewport = new Viewport({
      screenWidth: this.heatmapApp.screen.width,
      screenHeight: this.heatmapApp.screen.height,
      worldWidth: this.cellSize.width * this.extendedMaxSeriesLength,
      worldHeight: this.cellSize.height * (this.levels * 2),
      // interaction: this.heatmapApp.renderer.plugins.interaction
      events: this.heatmapApp.renderer.events
    });
    
    // 配置 Viewport
    this.heatmapViewport
      .drag({ wheel: false })
      .pinch()
      .wheel()
      .decelerate()
      // 添加事件监听器，在移动或缩放后更新坐标轴
      .on('moved', () => this.renderHeatmapAxes())
      .on('zoomed', () => this.renderHeatmapAxes())
      .on('moved-end', () => this.renderHeatmapAxes())
      .on('zoomed-end', () => this.renderHeatmapAxes());
    
    // 创建容器
    this.heatmapCellsContainer = new PIXI.Container();
    this.heatmapDeltasContainer = new PIXI.Container();
    this.heatmapAxesContainer = new PIXI.Container();
    
    this.barChartContainer = new PIXI.Container();
    this.barChartBarsContainer = new PIXI.Container();
    this.barChartAxesContainer = new PIXI.Container();
    
    // 添加容器到 Viewport
    this.heatmapViewport.addChild(this.heatmapCellsContainer);
    this.heatmapViewport.addChild(this.heatmapDeltasContainer);
    
    // 添加 Viewport 到舞台
    this.heatmapApp.stage.addChild(this.heatmapViewport);
    
    // 坐标轴容器添加到主舞台，不受 viewport 影响
    this.heatmapApp.stage.addChild(this.heatmapAxesContainer);
    
    // 添加条形图容器到舞台
    this.barChartApp.stage.addChild(this.barChartContainer);
    this.barChartContainer.addChild(this.barChartBarsContainer);
    this.barChartContainer.addChild(this.barChartAxesContainer);
    
    // 设置初始大小
    this.resizePixiApplications();
    
    // 处理窗口大小调整
    window.addEventListener('resize', () => this.resizePixiApplications());
  }
  
  resizePixiApplications() {
    const uiBarEl = document.querySelector('.ui');
    const heatmapEl = this.el.querySelector('.heatmap');
    const barChartEl = this.el.querySelector('.limit-orders-bar-chart');
    
    // Set heatmap size
    const heatmapWidth = heatmapEl.clientWidth || window.innerWidth * 0.66;
    const heatmapHeight = window.innerHeight - (uiBarEl ? uiBarEl.clientHeight : 0) - 7;
    
    this.heatmapApp.renderer.resize(heatmapWidth, heatmapHeight);
    
    // Set bar chart size
    const barChartWidth = barChartEl.clientWidth;
    const barChartHeight = barChartEl.clientHeight;
    
    this.barChartApp.renderer.resize(barChartWidth, barChartHeight);
    
    // 更新 Viewport 大小
    this.heatmapViewport.resize(
      heatmapWidth,
      heatmapHeight,
      this.cellSize.width * this.extendedMaxSeriesLength,
      this.cellSize.height * (this.levels * 2)
    );
    
    // Force redraw if we have data
    if (this.x.length > 0 && this.y.length > 0) {
      this.renderHeatmap();
      this.renderLimitOrdersBarChart();
    }
  }
  
  // setupEventListeners() {
  //   // 添加鼠标滚轮事件监听器，阻止页面滚动
  //   this.heatmapApp.canvas.addEventListener('wheel', (event) => {
  //     // 阻止默认的滚动行为
  //     event.preventDefault();
  //   }, { passive: false });
    
  //   // Heatmap interactions
  //   this.heatmapApp.canvas.addEventListener('mousemove', (event) => {
  //     // 将屏幕坐标转换为世界坐标
  //     const viewportPoint = this.heatmapViewport.toWorld(event.clientX - this.heatmapApp.canvas.getBoundingClientRect().left, 
  //                                                        event.clientY - this.heatmapApp.canvas.getBoundingClientRect().top);
      
  //     // 计算单元格索引
  //     const cellX = Math.floor(viewportPoint.x / this.cellSize.width);
  //     const cellY = Math.floor(viewportPoint.y / this.cellSize.height);
      
  //     // 检查是否有对应的数据点
  //     if (cellX >= 0 && cellX < this.x.length && cellY >= 0 && cellY < this.y.length) {
  //       const xValue = this.x[cellX];
  //       const yValue = this.y[cellY];
        
  //       // 查找订单簿数据
  //       for (const item of this.orderbook) {
  //         if (item.x === xValue && item.y === yValue) {
  //           window.tooltip.style.opacity = 1;
  //           window.tooltip.innerHTML = `${item.type}: ${fmtNum(item.value)}`;
  //           window.tooltip.style.left = (event.clientX + 10) + 'px';
  //           window.tooltip.style.top = (event.clientY + 10) + 'px';
  //           window.tooltip.style.backgroundColor = item.type === 'ask' ? '#faeaea' : '#eafaea';
  //           window.tooltip.style.borderColor = item.type === 'ask' ? 'red' : 'green';
  //           return;
  //         }
  //       }
  //     }
      
  //     window.tooltip.style.opacity = 0;
  //   });
    
  //   this.heatmapApp.canvas.addEventListener('mouseout', () => {
  //     window.tooltip.style.opacity = 0;
  //   });
  // }
  
  getDataPointFromCoordinates(x, y, chartType) {
    if (chartType === 'heatmap') {
      const margin = { top: 25, right: 100, bottom: 25, left: 25 };
      const width = this.heatmapApp.renderer.width - margin.left - margin.right;
      const height = this.heatmapApp.renderer.height - margin.top - margin.bottom;
      
      // Adjust coordinates to account for margins
      const adjustedX = x - margin.left;
      const adjustedY = y - margin.top;
      
      if (adjustedX < 0 || adjustedX > width || adjustedY < 0 || adjustedY > height) {
        return null;
      }
      
      // Calculate cell width and height
      const cellWidth = width / this.x.length;
      const cellHeight = height / this.y.length;
      
      // Calculate which cell was clicked
      const xIndex = Math.floor(adjustedX / cellWidth);
      const yIndex = Math.floor(adjustedY / cellHeight);
      
      if (xIndex < 0 || xIndex >= this.x.length || yIndex < 0 || yIndex >= this.y.length) {
        return null;
      }
      
      // Find the corresponding data point
      const xValue = this.x[xIndex];
      const yValue = this.y[yIndex];
      
      // Check for orderbook data
      for (const item of this.orderbook) {
        if (item.x === xValue && item.y === yValue) {
          return { type: 'orderbook', data: item };
        }
      }
      
      // Check for market order deltas
      for (const delta of this.mktOrderDeltas) {
        if (delta.x === xValue && Math.abs(this.y.indexOf(delta.y) - yIndex) <= 1) {
          // Check if the click is within the circle
          const centerX = margin.left + (xIndex + 0.5) * cellWidth;
          const centerY = margin.top + (this.y.indexOf(delta.y) + 0.5) * cellHeight;
          const radius = this.getDeltaDotRadius(delta.totalSize, cellHeight, Math.max(...this.mktOrderDeltas.map(x => x.totalSize)));
          
          const distance = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
          if (distance <= radius) {
            return { type: 'delta', data: delta };
          }
        }
      }
      
      return null;
    } else if (chartType === 'barchart') {
      const margin = { top: 20, right: 40, bottom: 25, left: 0 };
      const width = this.barChartApp.renderer.width - margin.left - margin.right;
      const height = this.barChartApp.renderer.height - margin.top - margin.bottom;
      
      // Adjust coordinates to account for margins
      const adjustedX = x - margin.left;
      const adjustedY = y - margin.top;
      
      if (adjustedX < 0 || adjustedX > width || adjustedY < 0 || adjustedY > height) {
        return null;
      }
      
      // Get sorted prices for x-axis
      const sortedPrices = [...this.y].sort((a, b) => parseFloat(a) - parseFloat(b));
      
      // Calculate bar width
      const barWidth = width / sortedPrices.length;
      
      // Calculate which bar was clicked
      const barIndex = Math.floor(adjustedX / barWidth);
      
      if (barIndex < 0 || barIndex >= sortedPrices.length) {
        return null;
      }
      
      // Find the corresponding price
      const price = sortedPrices[barIndex];
      
      // Find the corresponding data point in the latest orderbook snapshot
      for (let l = this.orderbook.length - 1; l > 0; l--) {
        const lvl = this.orderbook[l];
        if (lvl.x !== this.x[this.x.length - 1]) break;
        if (lvl.y === price) {
          return { type: 'bar', data: lvl };
        }
      }
      
      return null;
    }
    
    return null;
  }

  // restructure & derive secondary metrics from the OrderBook snapshot
  updateDashboard(snapshot) {
    // 计算时间戳
    const ts = fmtTime(new Date(), this.updateInterval);
    
    // 更新 x 轴（时间戳）
    this.x.push(ts);
    if (this.x.length > this.extendedMaxSeriesLength) {
      this.x.shift();
      
      // 移除旧的单元格和增量点
      this.cleanupOldCells();
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
      this.originPrice = this.tick.parse(this.y[midIndex]);
      
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
      this.addCell(askData);
      this.addCell(bidData);
      
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
    this.addDelta(delta);
    
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
    
    // 自动滚动到最新数据
    // this.scrollToLatestData();
  }

  // 更新价格到Y位置的映射
  updatePricePositions() {
    this.priceToYPosition.clear();
    
    for (const price of this.y) {
      const priceDiff = this.tick.parse(price) - this.originPrice;
      const yPosition = -priceDiff / this.priceStepSize;  // 负号是因为价格越高，y坐标越小
      this.priceToYPosition.set(price, yPosition);
    }
  }

  // 修改 addCell 方法，使用价格差值计算Y位置
  addCell(data) {
    const xIndex = this.x.indexOf(data.x);
    if (xIndex === -1) return;
    
    // 使用价格到Y位置的映射获取Y位置
    const yPosition = this.priceToYPosition.get(data.y);
    if (yPosition === undefined) return;
    
    const key = `${data.x}-${data.y}`;
    let cell = this.cellMap.get(key);
    
    // 如果单元格不存在，创建一个新的
    if (!cell) {
      cell = new PIXI.Graphics();
      this.heatmapCellsContainer.addChild(cell);
      this.cellMap.set(key, cell);
    }
    
    // 计算颜色
    let color = 0x000000; // 黑色
    
    if (data.value > 0) {
      let factor;
      if (this.heatmap.scale === 'log2') {
        factor = Math.log(data.value + 1) / Math.log2(this.maxDepth || 1);
      } else {
        factor = data.value / (this.heatmap.linearScaleCutoff * (this.maxDepth || 1));
      }
      factor = Math.min(1, Math.max(0, factor)); // 限制在 0 到 1 之间
      
      // 设置颜色范围
      let colorRange;
      if (this.heatmap.theme === 'bw') {
        colorRange = data.type === 'bid' ? ["#222222", "#ffffff"] : ["#222222", "#ffffff"];
      } else {
        colorRange = data.type === 'bid' ? ["#073247", "#00aaff"] : ["#2e0704", "#ff0000"];
      }
      
      // 插值颜色
      const hexColor = this.interpolateColor(colorRange[0], colorRange[1], factor);
      color = parseInt(hexColor.replace('#', '0x'));
    }
    
    // 更新单元格
    cell.clear();
    cell.beginFill(color);
    cell.drawRect(
      xIndex * this.cellSize.width,
      (yPosition + this.levels) * this.cellSize.height,  // 添加偏移量确保所有价格都在可见区域内
      this.cellSize.width,
      this.cellSize.height
    );
    cell.endFill();
    
    // 使单元格可交互
    cell.eventMode = 'static';
    
    // 存储单元格相关数据
    cell.cellData = data;
    cell.cellX = xIndex * this.cellSize.width;
    cell.cellY = (yPosition + this.levels) * this.cellSize.height;
    
    // 添加鼠标悬停事件
    cell.on('pointerover', (event) => {
      // 显示工具提示
      window.tooltip.style.opacity = 1;
      window.tooltip.innerHTML = `Price: ${data.y}<br/>${data.type}: ${fmtNum(data.value)}`;
      
      // 获取鼠标在屏幕上的位置
      const viewportPoint = this.heatmapViewport.toScreen(cell.cellX + this.cellSize.width/2, cell.cellY + this.cellSize.height/2);
      window.tooltip.style.left = (viewportPoint.x + 10) + 'px';
      window.tooltip.style.top = (viewportPoint.y - 10) + 'px';
      
      window.tooltip.style.backgroundColor = data.type === 'ask' ? '#faeaea' : '#eafaea';
      window.tooltip.style.borderColor = data.type === 'ask' ? 'red' : 'green';
    });
    
    // 添加鼠标移出事件
    cell.on('pointerout', () => {
      // 隐藏工具提示
      window.tooltip.style.opacity = 0;
    });
    
    // 添加鼠标移动事件，更新工具提示位置
    cell.on('pointermove', (event) => {
      const globalPos = event.global;
      window.tooltip.style.left = (globalPos.x + 10) + 'px';
      window.tooltip.style.top = (globalPos.y - 10) + 'px';
    });
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
      
      // 获取鼠标在屏幕上的位置
      const viewportPoint = this.heatmapViewport.toScreen(circle.centerX, circle.centerY);
      window.tooltip.style.left = (viewportPoint.x + 10) + 'px';
      window.tooltip.style.top = (viewportPoint.y - 10) + 'px';
      
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
    
    // 添加鼠标移动事件，更新工具提示位置
    circle.on('pointermove', (event) => {
      const globalPos = event.global;
      window.tooltip.style.left = (globalPos.x + 10) + 'px';
      window.tooltip.style.top = (globalPos.y - 10) + 'px';
    });
  }
  
  cleanupOldCells() {
    // 移除不再需要的单元格
    for (const [key, cell] of this.cellMap.entries()) {
      const [timestamp, price] = key.split('-');
      if (!this.x.includes(timestamp) || !this.y.includes(price)) {
        this.heatmapCellsContainer.removeChild(cell);
        this.cellMap.delete(key);
      }
    }
    
    // 移除不再需要的增量点
    for (const [key, circle] of this.deltaMap.entries()) {
      const [_, timestamp, price] = key.split('-');
      if (!this.x.includes(timestamp) || !this.y.includes(price)) {
        this.heatmapDeltasContainer.removeChild(circle);
        this.deltaMap.delete(key);
      }
    }
  }
  
  scrollToLatestData() {
    // 计算最新数据的位置
    const latestX = (this.x.length - 1) * this.cellSize.width;
    
    // 平移视图以显示最新数据
    this.heatmapViewport.moveCenter(latestX - this.cellSize.width * 2, this.heatmapViewport.center.y);
    
    // 更新坐标轴
    this.renderHeatmapAxes();
  }
  
  renderHeatmap() {
    // 不再需要完全重绘，只需更新坐标轴
    this.renderHeatmapAxes();
  }
  
  renderHeatmapAxes() {
    // 清除坐标轴容器
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
    const startY = Math.floor(visibleBounds.y / this.cellSize.height);
    const endY = Math.ceil((visibleBounds.y + visibleBounds.height) / this.cellSize.height);
    
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
    const yLabelPeriod = Math.ceil((endY - startY) / 10);
    for (let i = startY; i < endY; i += yLabelPeriod) {
      if (i >= 0 && i < this.y.length) {
        const worldY = i * this.cellSize.height;
        const screenY = this.heatmapViewport.toScreen(0, worldY).y;
        
        const label = new PIXI.Text(this.y[i], textStyle);
        label.anchor.set(0, 0.5);
        label.position.set(this.heatmapApp.screen.width - rightMargin + 5, screenY);
        this.heatmapAxesContainer.addChild(label);
      }
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
    const margin = { top: 20, right: 40, bottom: 25, left: 0 };
    const width = this.barChartApp.renderer.width - margin.left - margin.right;
    const height = this.barChartApp.renderer.height - margin.top - margin.bottom;
    
    // Clear containers
    this.barChartBarsContainer.removeChildren();
    this.barChartAxesContainer.removeChildren();
    
    // Set container position
    this.barChartContainer.position.set(margin.left, margin.top);
    
    // Prepare data
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

    // Sort prices from low to high for x-axis
    const sortedPrices = [...this.y].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    // Calculate bar width
    const barWidth = width / sortedPrices.length;
    
    // Find max value for scaling
    const max = Math.max(...[...askLevels, ...bidLevels].map(lvl => lvl.value), 1);
    
    // Draw bars
    for (const lvl of [...askLevels, ...bidLevels]) {
      const priceIndex = sortedPrices.indexOf(lvl.y);
      if (priceIndex === -1) continue;
      
      const x = priceIndex * barWidth;
      const barHeight = (lvl.value / max) * height;
      const y = height - barHeight;
      
      const color = lvl.type === 'bid' ? 0x073247 : 0x2e0704;
      const hoverColor = lvl.type === 'bid' ? 0x00aaff : 0xff0000;
      
      // 创建条形
      const bar = new PIXI.Graphics();
      bar.rect(x, y, barWidth * 0.8, barHeight);
      bar.fill({ color });
      
      // 使条形可交互
      bar.eventMode = 'static';
      
      // 存储条形相关数据
      bar.lvlData = lvl;
      
      // 添加鼠标悬停事件
      bar.on('pointerover', (event) => {
        // 高亮显示条形
        bar.clear();
        bar.rect(x, y, barWidth * 0.8, barHeight);
        bar.fill({ color: hoverColor });
        
        // 显示工具提示
        window.tooltip.style.opacity = 1;
        window.tooltip.innerHTML = `Price: ${lvl.y}<br/>${lvl.type}: ${fmtNum(lvl.value)}`;
        window.tooltip.style.left = (event.clientX + 10) + 'px';
        window.tooltip.style.top = (event.clientY - 10) + 'px';
        window.tooltip.style.backgroundColor = lvl.type === 'ask' ? '#faeaea' : '#eafaea';
        window.tooltip.style.borderColor = lvl.type === 'ask' ? 'red' : 'green';
      });
      
      // 添加鼠标移出事件
      bar.on('pointerout', () => {
        // 恢复条形原始颜色
        bar.clear();
        bar.rect(x, y, barWidth * 0.8, barHeight);
        bar.fill({ color });
        
        // 隐藏工具提示
        window.tooltip.style.opacity = 0;
      });
      
      // 添加鼠标移动事件，更新工具提示位置
      bar.on('pointermove', (event) => {
        window.tooltip.style.left = (event.clientX + 10) + 'px';
        window.tooltip.style.top = (event.clientY + 10) + 'px';
      });
      
      this.barChartBarsContainer.addChild(bar);
    }
    
    // Draw axes
    this.drawBarChartAxes(width, height, barWidth, max, sortedPrices);
  }
  
  drawBarChartAxes(width, height, barWidth, maxValue, sortedPrices) {
    // Create text style
    const textStyle = new PIXI.TextStyle({
      fontFamily: 'Arial',
      fontSize: 10,
      fill: '#ffffff',
    });
    
    // Draw x-axis
    const xAxis = new PIXI.Graphics();
    xAxis.lineStyle(1, 0x666666);
    xAxis.moveTo(0, height);
    xAxis.lineTo(width, height);
    this.barChartAxesContainer.addChild(xAxis);
    
    // Draw x-axis labels
    const xLabelPeriod = Math.ceil(sortedPrices.length / 10);
    for (let i = 0; i < sortedPrices.length; i += xLabelPeriod) {
      const x = (i + 0.5) * barWidth;
      const label = new PIXI.Text(sortedPrices[i], textStyle);
      label.anchor.set(0.5, 0);
      label.position.set(x, height + 5);
      this.barChartAxesContainer.addChild(label);
    }
    
    // Draw y-axis
    const yAxis = new PIXI.Graphics();
    yAxis.lineStyle(1, 0x666666);
    yAxis.moveTo(width, 0);
    yAxis.lineTo(width, height);
    this.barChartAxesContainer.addChild(yAxis);
    
    // Draw y-axis labels
    const yLabelCount = 5;
    for (let i = 0; i <= yLabelCount; i++) {
      const value = (i / yLabelCount) * maxValue;
      const y = height - (i / yLabelCount) * height;
      const label = new PIXI.Text(fmtNum(value), textStyle);
      label.anchor.set(0, 0.5);
      label.position.set(width + 5, y);
      this.barChartAxesContainer.addChild(label);
    }
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

  clearDashboardIntervals() {
    for (let i = 0, l = this.intervals.length; i < l; i++) {
      clearInterval(this.intervals[i]);
    }
    
    // Destroy PixiJS applications to free resources
    if (this.heatmapApp) {
      this.heatmapApp.destroy(true, true);
    }
    
    if (this.barChartApp) {
      this.barChartApp.destroy(true, true);
    }
  }
}