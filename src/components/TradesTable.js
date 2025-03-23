import { fmtNum } from '../../lib/fmt.js';

export default class TradesTable {
  constructor(container, tick) {
    this.container = container;
    this.tick = tick;
    this.topTradeSize = 0;
  }
  
  update(trades, topTradeSize) {
    this.topTradeSize = topTradeSize;
    
    // 确保容器可见
    if (this.container.style.display === 'none') {
      this.container.style.display = '';
    }
    
    // 获取表格体
    const tradesBody = this.container.querySelector('.trades-body');
    
    // 清空现有行
    while (tradesBody.firstChild) {
      tradesBody.removeChild(tradesBody.firstChild);
    }
    
    // 添加所有交易记录，按时间戳排序
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const row = tradesBody.insertRow(0);
      
      // 设置行的类
      row.classList = trade.isBuy ? 'buy' : 'sell';
      row.classList += trade.size >= this.topTradeSize ? ' top-trade' : '';
      
      // 添加数量单元格
      let cell = row.insertCell();
      let text = document.createTextNode(trade.size);
      cell.appendChild(text);
      
      // 添加价格单元格
      cell = row.insertCell();
      text = document.createTextNode(this.tick.parse(trade.price));
      cell.appendChild(text);
      
      // 添加时间单元格
      cell = row.insertCell();
      text = document.createTextNode(trade.time);
      cell.appendChild(text);
    }
  }

  resize() {
    // 如果需要在窗口大小变化时调整表格样式，可以在这里添加逻辑
    // 例如，调整行高、字体大小等
  }
} 