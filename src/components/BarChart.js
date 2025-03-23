import * as PIXI from 'pixi.js';
import { fmtNum } from '../../lib/fmt.js';

export default class BarChart {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      margin: { top: 20, right: 40, bottom: 25, left: 0 },
      ...options
    };
    
    // PixiJS 应用
    this.app = null;
    
    // 容器
    this.chartContainer = null;
    this.barsContainer = null;
    this.axesContainer = null;
    
    // 初始化
    this.init();
  }
  
  async init() {
    // 清空容器
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
    
    // 创建 PixiJS 应用
    this.app = new PIXI.Application();
    await this.app.init({
      background: '#000000',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    // 添加视图到 DOM
    this.container.appendChild(this.app.canvas);
    
    // 阻止滚轮事件引起页面滚动
    this.container.addEventListener('wheel', (event) => {
      event.preventDefault();
    }, { passive: false });
    
    // 设置视图样式
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    
    // 创建容器
    this.chartContainer = new PIXI.Container();
    this.barsContainer = new PIXI.Container();
    this.axesContainer = new PIXI.Container();
    
    // 添加容器到舞台
    this.app.stage.addChild(this.chartContainer);
    this.chartContainer.addChild(this.barsContainer);
    this.chartContainer.addChild(this.axesContainer);
    
    // 设置容器位置
    this.chartContainer.position.set(this.options.margin.left, this.options.margin.top);
    
    // 监听窗口大小变化
    window.addEventListener('resize', () => this.resize());
    
    // 初始化大小
    this.resize();
  }
  
  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    if (width > 0 && height > 0) {
      this.app.renderer.resize(width, height);
    }
  }
  
  // 渲染条形图
  render(askLevels, bidLevels, sortedPrices) {
    const margin = this.options.margin;
    const width = this.app.renderer.width - margin.left - margin.right;
    const height = this.app.renderer.height - margin.top - margin.bottom;
    
    // 清空容器
    this.barsContainer.removeChildren();
    this.axesContainer.removeChildren();
    
    // 设置容器位置
    this.chartContainer.position.set(margin.left, margin.top);
    
    // 计算条形宽度
    const barWidth = width / sortedPrices.length;
    
    // 找出最大值用于缩放
    const max = Math.max(...[...askLevels, ...bidLevels].map(lvl => lvl.value), 1);
    
    // 绘制条形
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
      
      this.barsContainer.addChild(bar);
    }
    
    // 绘制坐标轴
    this.drawAxes(width, height, barWidth, max, sortedPrices);
  }
  
  // 绘制坐标轴
  drawAxes(width, height, barWidth, maxValue, sortedPrices) {
    // 创建文本样式
    const textStyle = new PIXI.TextStyle({
      fontFamily: 'Arial',
      fontSize: 10,
      fill: '#ffffff',
    });
    
    // 绘制 x 轴
    const xAxis = new PIXI.Graphics();
    xAxis.lineStyle(1, 0x666666);
    xAxis.moveTo(0, height);
    xAxis.lineTo(width, height);
    this.axesContainer.addChild(xAxis);
    
    // 绘制 x 轴标签
    const xLabelPeriod = Math.ceil(sortedPrices.length / 10);
    for (let i = 0; i < sortedPrices.length; i += xLabelPeriod) {
      const x = (i + 0.5) * barWidth;
      const label = new PIXI.Text(sortedPrices[i], textStyle);
      label.anchor.set(0.5, 0);
      label.position.set(x, height + 5);
      this.axesContainer.addChild(label);
    }
    
    // 绘制 y 轴
    const yAxis = new PIXI.Graphics();
    yAxis.lineStyle(1, 0x666666);
    yAxis.moveTo(width, 0);
    yAxis.lineTo(width, height);
    this.axesContainer.addChild(yAxis);
    
    // 绘制 y 轴标签
    const yLabelCount = 5;
    for (let i = 0; i <= yLabelCount; i++) {
      const value = (i / yLabelCount) * maxValue;
      const y = height - (i / yLabelCount) * height;
      const label = new PIXI.Text(fmtNum(value), textStyle);
      label.anchor.set(0, 0.5);
      label.position.set(width + 5, y);
      this.axesContainer.addChild(label);
    }
  }
  
  // 销毁
  destroy() {
    if (this.app) {
      this.app.destroy(true, true);
    }
  }
} 