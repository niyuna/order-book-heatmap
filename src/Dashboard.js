import * as d3 from "d3";

import DataFeed from '../lib/BinanceDataFeed.js';
import OrderBook from '../lib/BinanceOrderBook.js';
import Tick from '../lib/Tick.js';
import { numCompare } from '../lib/utils.js'; 
import { fmtNum, fmtTime } from '../lib/fmt.js';

export default class Dashboard {
  constructor(el, feed, symbol, tickSize, updateInterval=250, levels=10, aggregation=1, maxSeriesLength=5, scale='linear', theme='rb') {
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
    console.log(this.maxSeriesLength);

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

    // Canvas elements
    this.heatmapCanvas = null;
    this.barChartCanvas = null;
    this.setupCanvases();

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
        this.renderHeatmap();
        this.renderTimeAndSales();
        this.renderLimitOrdersBarChart();
      }
    }, updateInterval);
    this.intervals.push(rerenderInterval);

    // recalculate order book intensity every 2 seconds
    let recalculateDepth = setInterval(() => {
      let maxDepth = 0;
      for (let i = 0, l = this.orderbook.length; i < l; i++) {
        if (this.orderbook[i].value > maxDepth)
          maxDepth = this.orderbook[i].value;
      }

      this.maxDepth = maxDepth;
    }, 2000);
    this.intervals.push(recalculateDepth);

    // Add event listeners for canvas interactions
    this.setupEventListeners();
  }

  setupCanvases() {
    // Setup heatmap canvas
    const heatmapEl = this.el.querySelector('.heatmap');
    if (heatmapEl.querySelector('canvas')) {
      heatmapEl.querySelector('canvas').remove();
    }
    // 确保移除所有 SVG 元素
    const heatmapSvgs = heatmapEl.querySelectorAll('svg');
    heatmapSvgs.forEach(svg => svg.remove());
    
    this.heatmapCanvas = document.createElement('canvas');
    this.heatmapCanvas.style.width = '100%';
    this.heatmapCanvas.style.height = '100%';
    heatmapEl.appendChild(this.heatmapCanvas);
    
    // Setup bar chart canvas
    const barChartEl = this.el.querySelector('.limit-orders-bar-chart');
    if (barChartEl.querySelector('canvas')) {
      barChartEl.querySelector('canvas').remove();
    }
    // 确保移除所有 SVG 元素
    const barChartSvgs = barChartEl.querySelectorAll('svg');
    barChartSvgs.forEach(svg => svg.remove());
    
    this.barChartCanvas = document.createElement('canvas');
    this.barChartCanvas.style.width = '100%';
    this.barChartCanvas.style.height = '100%';
    barChartEl.appendChild(this.barChartCanvas);
    
    // Set initial canvas sizes
    this.resizeCanvases();
    
    // Handle window resize
    window.addEventListener('resize', () => this.resizeCanvases());
  }
  
  resizeCanvases() {
    const uiBarEl = document.querySelector('.ui');
    const heatmapEl = this.el.querySelector('.heatmap');
    const barChartEl = this.el.querySelector('.limit-orders-bar-chart');
    
    // Set heatmap canvas size with pixel ratio for high DPI displays
    const pixelRatio = window.devicePixelRatio || 1;
    const heatmapWidth = heatmapEl.clientWidth || window.innerWidth * 0.66;
    const heatmapHeight = window.innerHeight - (uiBarEl ? uiBarEl.clientHeight : 0) - 7;
    
    this.heatmapCanvas.width = heatmapWidth * pixelRatio;
    this.heatmapCanvas.height = heatmapHeight * pixelRatio;
    this.heatmapCanvas.style.width = `${heatmapWidth}px`;
    this.heatmapCanvas.style.height = `${heatmapHeight}px`;
    
    // Set bar chart canvas size
    const barChartWidth = barChartEl.clientWidth;
    const barChartHeight = barChartEl.clientHeight;
    
    this.barChartCanvas.width = barChartWidth * pixelRatio;
    this.barChartCanvas.height = barChartHeight * pixelRatio;
    this.barChartCanvas.style.width = `${barChartWidth}px`;
    this.barChartCanvas.style.height = `${barChartHeight}px`;
    
    // Force redraw if we have data
    if (this.x.length > 0 && this.y.length > 0) {
      this.renderHeatmap();
      this.renderLimitOrdersBarChart();
    }
  }
  
  setupEventListeners() {
    // Heatmap canvas mouse events
    this.heatmapCanvas.addEventListener('mousemove', (event) => {
      const rect = this.heatmapCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      const dataPoint = this.getDataPointFromCoordinates(x, y, 'heatmap');
      if (dataPoint) {
        window.tooltip.style.opacity = 1;
        window.tooltip.innerHTML = dataPoint.type === 'orderbook' 
          ? `${dataPoint.data.type}: ${fmtNum(dataPoint.data.value)}`
          : dataPoint.data.msgHTML;
        window.tooltip.style.left = (event.clientX + 10) + 'px';
        window.tooltip.style.top = (event.clientY + 10) + 'px';
        window.tooltip.style.backgroundColor = dataPoint.data.type === 'ask' ? '#faeaea' : '#eafaea';
        window.tooltip.style.borderColor = dataPoint.data.type === 'ask' ? 'red' : 'green';
      } else {
        window.tooltip.style.opacity = 0;
      }
    });
    
    this.heatmapCanvas.addEventListener('mouseout', () => {
      window.tooltip.style.opacity = 0;
    });
    
    // Bar chart canvas mouse events
    this.barChartCanvas.addEventListener('mousemove', (event) => {
      const rect = this.barChartCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      const dataPoint = this.getDataPointFromCoordinates(x, y, 'barchart');
      if (dataPoint) {
        window.tooltip.style.opacity = 1;
        window.tooltip.innerHTML = `Price: ${dataPoint.data.y}<br/>
                                   ${dataPoint.data.type}: ${fmtNum(dataPoint.data.value)}`;
        window.tooltip.style.left = (event.clientX + 10) + 'px';
        window.tooltip.style.top = (event.clientY + 10) + 'px';
        window.tooltip.style.backgroundColor = dataPoint.data.type === 'ask' ? '#faeaea' : '#eafaea';
        window.tooltip.style.borderColor = dataPoint.data.type === 'ask' ? 'red' : 'green';
      } else {
        window.tooltip.style.opacity = 0;
      }
    });
    
    this.barChartCanvas.addEventListener('mouseout', () => {
      window.tooltip.style.opacity = 0;
    });
  }
  
  getDataPointFromCoordinates(x, y, chartType) {
    const pixelRatio = window.devicePixelRatio || 1;
    x *= pixelRatio;
    y *= pixelRatio;
    
    if (chartType === 'heatmap') {
      // Calculate which cell in the heatmap was clicked
      const margin = { top: 25 * pixelRatio, right: 100 * pixelRatio, bottom: 25 * pixelRatio, left: 25 * pixelRatio };
      const width = this.heatmapCanvas.width - margin.left - margin.right;
      const height = this.heatmapCanvas.height - margin.top - margin.bottom;
      
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
      // Calculate which bar in the bar chart was clicked
      const margin = { top: 20 * pixelRatio, right: 40 * pixelRatio, bottom: 25 * pixelRatio, left: 0 };
      const width = this.barChartCanvas.width - margin.left - margin.right;
      const height = this.barChartCanvas.height - margin.top - margin.bottom;
      
      // Adjust coordinates to account for margins
      const adjustedX = x - margin.left;
      const adjustedY = y - margin.top;
      
      if (adjustedX < 0 || adjustedX > width || adjustedY < 0 || adjustedY > height) {
        return null;
      }
      
      // Calculate bar width
      const barWidth = width / this.y.length;
      
      // Calculate which bar was clicked
      const barIndex = Math.floor(adjustedX / barWidth);
      
      if (barIndex < 0 || barIndex >= this.y.length) {
        return null;
      }
      
      // Find the corresponding price level
      const price = this.y[barIndex];
      
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
  // truncate old data
  updateDashboard(snapshot) {
    // calculate depth for N extra bid & offer levels, but don't
    // include them in the centered Y axis.
    // Better visualization in volatile market
    const maxSeriesLength = this.maxSeriesLength;
    const ts = fmtTime(new Date(), this.updateInterval);

    // update heatmap axes
    this.x.push(ts);
    if (this.x.length > maxSeriesLength) {
      this.x.shift()
    }


    this.y = snapshot.aggBidPrices
      .reverse()
      .slice(this.bufferLevels === 0 ? 0 : this.bufferLevels - 1);

    // push spread prices (not in bid or ask) to the yAxis
    let nextP = this.tick.incrStep(this.y[ this.y.length - 1]);
    while (nextP !== snapshot.aggAskPrices[0]) {
      this.y.push(nextP);
      nextP = this.tick.incrStep(this.y[ this.y.length - 1]);
    }

    this.y = this.y.concat(
      snapshot.aggAskPrices.slice(0, this.levels - 1)
    );

    // update dashboard data
    for (let i = 0; i < this.levels + this.bufferLevels; i++) {
      this.orderbook.push({
        value: snapshot.aggAskSizes[i],
        y: snapshot.aggAskPrices[i],
        x: ts,
        type: 'ask',
      });

      this.orderbook.push({
        value: snapshot.aggBidSizes[i],
        y: snapshot.aggBidPrices[i],
        x: ts,
        type: 'bid',
      });

      // update maxDepth for heatmap intensity
      if (snapshot.aggAskSizes[i] > this.maxDepth)
        this.maxDepth = snapshot.aggAskSizes[i];
      if (snapshot.aggBidSizes[i] > this.maxDepth)
        this.maxDepth = snapshot.aggBidSizes[i];
    }

    const maxOrderbookLength = maxSeriesLength * (this.levels + this.bufferLevels) * 2;
    if (this.orderbook.length > maxOrderbookLength) {
      this.orderbook = this.orderbook.slice((this.levels + this.bufferLevels) * 2);
    }

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
    if (this.mktBuys.length > maxSeriesLength) {
      this.askLine.shift();
      this.bidLine.shift();
    }

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

    // tooltip message
    delta.msgHTML = `${delta.totalSize} contracts traded<br/>`;
    delta.msgHTML = `${delta.msgHTML}${snapshot.stats.mktBuySize} contracts bought (${snapshot.stats.mktBuyOrders}) orders<br/>`;
    delta.msgHTML = `${delta.msgHTML}${snapshot.stats.mktSellSize} contracts sold (${snapshot.stats.mktSellOrders}) orders`;

    if (sizeDelta > 0) {
      delta.y = snapshot.stats.avgBuyVWAP;
      // type is used purely for tooltip styling
      delta.type = 'bid';
    } else {
      delta.y = snapshot.stats.avgSellVWAP;
      delta.type = 'ask';
    }

    this.mktOrderDeltas.push(delta);


    if (this.mktBuys.length > maxSeriesLength) {
      this.mktBuys.shift();
      this.mktSells.shift();
      this.mktOrderDeltas.shift();
    }

    // update trades
    this.trades = this.trades.concat(snapshot.trades);
    if (this.trades.length > maxSeriesLength)
      this.trades = this.trades.slice( this.trades.length - maxSeriesLength );

    const sortedTrades = this.trades
      .map(trade => trade.size)
      .sort((a, b) => a - b);
    const top10PercentileIndex = Math.floor(sortedTrades.length - 1 - sortedTrades.length / 10);
    this.topTradeSize = sortedTrades[top10PercentileIndex] || 0;
  }

  renderHeatmap() {
    const pixelRatio = window.devicePixelRatio || 1;
    const margin = {
      top: 25 * pixelRatio,
      right: 100 * pixelRatio,
      bottom: 25 * pixelRatio,
      left: 25 * pixelRatio
    };

    const canvas = this.heatmapCanvas;
    const ctx = canvas.getContext('2d');
    ctx.scale(pixelRatio, pixelRatio);
    
    const width = (canvas.width / pixelRatio) - margin.left / pixelRatio - margin.right / pixelRatio;
    const height = (canvas.height / pixelRatio) - margin.top / pixelRatio - margin.bottom / pixelRatio;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width / pixelRatio, canvas.height / pixelRatio);
    
    // Draw background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width / pixelRatio, canvas.height / pixelRatio);
    
    // Calculate cell dimensions
    const cellWidth = width / this.x.length;
    const cellHeight = height / this.y.length;
    
    // Draw heatmap cells
    const visibleBook = this.orderbook.filter(d => 
      d.y >= this.y[0] && d.y <= this.y[this.y.length - 1]
    );
    
    // Set up color scales
    let bidColorRange = ["#073247", "#00aaff"];
    let askColorRange = ["#2e0704", "#ff0000"];

    if (this.heatmap.theme === 'bw') {
      bidColorRange = ["#222222", "#ffffff"];
      askColorRange = ["#222222", "#ffffff"];
    }
    
    // Helper function to interpolate colors
    const interpolateColor = (color1, color2, factor) => {
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
    };
    
    // Draw cells
    for (const d of visibleBook) {
      const xIndex = this.x.indexOf(d.x);
      const yIndex = this.y.indexOf(d.y);
      
      if (xIndex === -1 || yIndex === -1) continue;
      
      const x = margin.left / pixelRatio + xIndex * cellWidth;
      const y = margin.top / pixelRatio + yIndex * cellHeight;
      
      if (d.value === 0) {
        ctx.fillStyle = '#000000';
      } else {
        let factor;
        if (this.heatmap.scale === 'log2') {
          factor = Math.log(d.value + 1) / Math.log2(this.maxDepth || 1);
        } else {
          factor = d.value / (this.heatmap.linearScaleCutoff * (this.maxDepth || 1));
        }
        factor = Math.min(1, Math.max(0, factor)); // Clamp between 0 and 1
        
        const colorRange = d.type === 'bid' ? bidColorRange : askColorRange;
        ctx.fillStyle = interpolateColor(colorRange[0], colorRange[1], factor);
      }
      
      ctx.fillRect(x, y, cellWidth, cellHeight);
    }
    
    // Draw market order delta dots
    const sDeltaValues = this.mktOrderDeltas.map(x => x.value).sort(numCompare);
    const maxTradedSize = Math.max(...this.mktOrderDeltas.map(x => x.totalSize), 1);
    
    const buyDeltaColorRange = ["#00d7ff", "#56fffa"];
    const sellDeltaColorRange = ["#ff9100", "#fff400"];
    
    const visibleOrders = this.mktOrderDeltas.filter(order => 
      order.y >= this.y[0] && order.y <= this.y[this.y.length - 1] && order.totalSize > 0
    );
    
    for (const d of visibleOrders) {
      const xIndex = this.x.indexOf(d.x);
      const yIndex = this.y.indexOf(d.y);
      
      if (xIndex === -1 || yIndex === -1) continue;
      
      const cx = margin.left / pixelRatio + (xIndex + 0.5) * cellWidth;
      const cy = margin.top / pixelRatio + (yIndex + 0.5) * cellHeight;
      const radius = this.getDeltaDotRadius(d.totalSize, cellHeight, maxTradedSize);
      
      const factor = sDeltaValues.length > 1 ? 
        (d.value - sDeltaValues[0]) / (sDeltaValues[sDeltaValues.length - 1] - sDeltaValues[0]) : 
        0.5;
      const colorRange = d.type === 'ask' ? sellDeltaColorRange : buyDeltaColorRange;
      ctx.fillStyle = interpolateColor(colorRange[0], colorRange[1], factor);
      
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
    }
    
    // Draw axes
    this.drawHeatmapAxes(ctx, margin, width, height, pixelRatio);
    
    // Reset scale
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  
  drawHeatmapAxes(ctx, margin, width, height, pixelRatio) {
    ctx.strokeStyle = '#666666';
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    
    // Draw x-axis
    ctx.beginPath();
    ctx.moveTo(margin.left / pixelRatio, margin.top / pixelRatio + height);
    ctx.lineTo(margin.left / pixelRatio + width, margin.top / pixelRatio + height);
    ctx.stroke();
    
    // Draw x-axis labels
    const xLabelPeriod = Math.ceil(this.maxSeriesLength / 10);
    for (let i = 0; i < this.x.length; i += xLabelPeriod) {
      const x = margin.left / pixelRatio + (i + 0.5) * (width / this.x.length);
      ctx.fillText(this.x[i], x, margin.top / pixelRatio + height + 15);
    }
    
    // Draw y-axis
    ctx.beginPath();
    ctx.moveTo(margin.left / pixelRatio + width, margin.top / pixelRatio);
    ctx.lineTo(margin.left / pixelRatio + width, margin.top / pixelRatio + height);
    ctx.stroke();
    
    // Draw y-axis labels
    for (let i = 0; i < this.y.length; i++) {
      const y = margin.top / pixelRatio + (i + 0.5) * (height / this.y.length);
      ctx.textAlign = 'left';
      ctx.fillText(this.y[i], margin.left / pixelRatio + width + 5, y);
    }
  }

  renderTimeAndSales() {
    const tradesWrapper = this.el.querySelector('.trades');
    if (tradesWrapper.style.display === 'none') {
      tradesWrapper.style.display = '';
    }

    const trades = this.el.querySelector('.trades-body');
    
    // Clear existing rows
    while (trades.firstChild) {
      trades.removeChild(trades.firstChild);
    }

    // push all recent trades ordered by timestamp & label them as buy / sell
    for (let i = 0; i < this.trades.length; i++) {
      const row = trades.insertRow(0);
      row.classList = this.trades[i].isBuy ? 'buy' : 'sell';
      row.classList += this.trades[i].size >= this.topTradeSize ? ' top-trade' : '';

      let cell = row.insertCell();
      let text = document.createTextNode(this.trades[i].size);
      cell.appendChild(text);
 
      cell = row.insertCell();
      text = document.createTextNode(this.tick.parse(this.trades[i].price));
      cell.appendChild(text);

      cell = row.insertCell();
      text = document.createTextNode(this.trades[i].time);
      cell.appendChild(text);
    }
  }

  renderLimitOrdersBarChart() {
    const pixelRatio = window.devicePixelRatio || 1;
    const canvas = this.barChartCanvas;
    const ctx = canvas.getContext('2d');
    ctx.scale(pixelRatio, pixelRatio);
    
    const margin = {
      top: 20, 
      right: 40, 
      bottom: 25, 
      left: 0
    };
    
    const width = (canvas.width / pixelRatio) - margin.left - margin.right;
    const height = (canvas.height / pixelRatio) - margin.top - margin.bottom;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width / pixelRatio, canvas.height / pixelRatio);
    
    // Draw background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width / pixelRatio, canvas.height / pixelRatio);
    
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

    const timeCmpr = (a, b) => (a.y > b.y) ? 1 : -1;
    askLevels.sort(timeCmpr);
    bidLevels.sort(timeCmpr);

    const levels = bidLevels.concat(askLevels);
    const max = Math.max(...levels.map(lvl => lvl.value), 1); // Ensure max is at least 1
    
    // Calculate bar width
    const barWidth = width / this.y.length;
    
    // Draw bars
    for (const lvl of levels) {
      const yIndex = this.y.indexOf(lvl.y);
      if (yIndex === -1) continue;
      
      const x = margin.left + yIndex * barWidth;
      const barHeight = (lvl.value / max) * height;
      const y = margin.top + height - barHeight;
      
      ctx.fillStyle = lvl.type === 'bid' ? "#073247" : "#2e0704";
      ctx.fillRect(x, y, barWidth * 0.8, barHeight);
    }
    
    // Draw axes
    this.drawBarChartAxes(ctx, margin, width, height, max);
    
    // Reset scale
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  
  drawBarChartAxes(ctx, margin, width, height, maxValue) {
    ctx.strokeStyle = '#666666';
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px Arial';
    
    // Draw x-axis
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + height);
    ctx.lineTo(margin.left + width, margin.top + height);
    ctx.stroke();
    
    // Draw x-axis labels
    const xLabelPeriod = Math.ceil(this.levels / 2);
    const nthLabel = Math.ceil(xLabelPeriod / 2);
    
    ctx.textAlign = 'center';
    for (let i = 0; i < this.y.length; i += xLabelPeriod) {
      // if (i % xLabelPeriod === nthLabel) {
        const x = margin.left + (i + 0.5) * (width / this.y.length);
        ctx.fillText(this.y[i], x, margin.top + height + 15);
      // }
    }
    
    // Draw y-axis
    ctx.beginPath();
    ctx.moveTo(margin.left + width, margin.top);
    ctx.lineTo(margin.left + width, margin.top + height);
    ctx.stroke();
    
    // Draw y-axis labels
    const yLabelCount = 5;
    ctx.textAlign = 'left';
    for (let i = 0; i <= yLabelCount; i++) {
      const value = (i / yLabelCount) * maxValue;
      const y = margin.top + height - (i / yLabelCount) * height;
      ctx.fillText(fmtNum(value), margin.left + width + 5, y);
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
  }
}