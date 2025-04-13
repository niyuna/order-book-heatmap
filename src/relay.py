from typing import Dict, Union, List, Optional, Any

from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from pydantic import BaseModel

import csv
from io import StringIO

import json
from datetime import datetime, timedelta
import sqlite3
import time
import os
import re
import pytz
import threading
from collections import OrderedDict, defaultdict
import asyncio
import logging

# 可配置的常量
DB_PATH = os.environ.get('DB_PATH', 'F:\\kabu\\ita.db')
FRAMES_OUTPUT_DIR = os.environ.get('FRAMES_OUTPUT_DIR', 'D:\\dev\\github\\brisk-hack\\brisk_in_day_frames')
BRISK_FRAMES_DIR = os.environ.get('BRISK_FRAMES_DIR', 'D:\\dev\\github\\brisk-hack\\brisk_raw_frames')

app = FastAPI()

shared_vars = {}
shared_vars['active_ws_connection'] = []

origins = [
    "http://localhost:3000",
    "https://sbi.brisk.jp",
    "https://docs.google.com",
    "http://localhost:8888",
    "http://localhost:8080"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Frame(BaseModel):
    frameNumber: int
    price10: int
    quantity: int
    timestamp: int
    type: int


class StockInfo(BaseModel):
    issueCode: str
    name: str
    prefix: str
    basePrice: float
    lastPrice: float
    openPrice: float
    volume: int


class BriskCommand(BaseModel):
    command: str
    args: List[str]


class ItaOrder(BaseModel):
    o: int # number of transaction in order
    q: int # number of stock in order


class ItaRow(BaseModel):
    p: float = -1 # price
    s: int = 0 # special if 1
    a: Optional[ItaOrder] = None # ask
    b: Optional[ItaOrder] = None # bid
    c: Optional[ItaOrder] = None # askClose
    d: Optional[ItaOrder] = None # bidClose


class Ita(BaseModel):
    rows: List[ItaRow]
    frame: int
    over: Optional[ItaRow] = None
    under: Optional[ItaRow] = None
    timestamp: str


def get_db():
    if not hasattr(app.state, "db"):
        app.state.db = sqlite3.connect(DB_PATH, check_same_thread=False)
        app.state.db.row_factory = sqlite3.Row
    return app.state.db


def init_db():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS Ita (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sc TEXT NOT NULL,
        frameNum INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        itaString TEXT NOT NULL
    )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ita_sc_frameNum ON Ita (sc, frameNum)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ita_sc_timestamp ON Ita (sc, timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ita_timestamp ON Ita (timestamp)')
    db.commit()


@app.on_event("startup")
def startup():
    init_db()

@app.get("/latestFrame")
def read_latest_frame():
    return shared_vars.get('latest_frame', {})


@app.post("/latestFrame")
def post_latest_frame(frame : Dict[int, Frame]):
    shared_vars['latest_frame'] = frame
    return ['ok', len(frame)]


@app.post("/inDayFrames")
def post_in_day_frames(frames : Dict[str, List[Frame]]):
    data_dict = frames
    
    ts = int(datetime.now().timestamp())
    current_date = datetime.now()
    formatted_date = current_date.strftime("%Y%m%d")
    new_frame_cnt = sum(len(f) for f in frames.values())
    if new_frame_cnt > 0:
        # 确保输出目录存在
        os.makedirs(FRAMES_OUTPUT_DIR, exist_ok=True)
        file_name = f"{FRAMES_OUTPUT_DIR}/brisk_in_day_frames_{formatted_date}_{ts}.json"
        for i in range(3):
            try:
                with open(file_name, "w") as f:
                    json.dump(data_dict, f, default=vars)
                break
            except Exception as e :
                # handle the write WIP case
                print(f'{time.ctime()}: getting writing WIP issue')
                print(e)
                time.sleep(0.5)
        else:
            raise Exception('writing frame exception exceed max try')
    return ['ok, new frame cnt: ', new_frame_cnt]


@app.post("/inDayItaDict")
def post_in_day_ita_dict(ita_dict: Dict[str, Ita], db: sqlite3.Connection = Depends(get_db)):
    # print(ita_dict)
    for sc, ita in ita_dict.items():
        # print(sc, ita.frame, ita.under, ita.over, ita.timestamp, ita.rows)
        try:
            db.execute(
                "INSERT INTO Ita (sc, frameNum, timestamp, itaString) VALUES (?, ?, ?, ?)",
                (sc, ita.frame, ita.timestamp, ita.json(exclude_none=True, exclude_defaults=True, exclude_unset=True))
            )
            db.commit()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Insertion failed: {e}")

    return ['ok']


@app.post("/brisk-next-command")
async def post_brisk_next_command(command: BriskCommand):
    # for connection in shared_vars['active_ws_connection']:
    #     await connection.send_text(f"{command.command} {','.join(command.args)}")
    awaitmanager.broadcast(command.command)
    return ['ok', command.command]


@app.get("/brisk-next-command")
async def get_brisk_next_command(cmd: str, args: str):
    print(cmd, args)
    # for connection in shared_vars['active_ws_connection']:
    #     await connection.send_text(f"{cmd} {args}")
    await manager.broadcast(f"{cmd} {args}")
    return ['ok', cmd]


# @app.websocket("/ws")
# async def websocket_endpoint(websocket: WebSocket):
#     await websocket.accept()
#     shared_vars['active_ws_connection'].append(websocket)
#     try:
#         while True:
#             data = await websocket.receive_text()
#             print(data)
#     except WebSocketDisconnect:
#         print("Client disconnected")
#         shared_vars['active_ws_connection'].remove(websocket)


# 使用线程安全的 OrderedDict 作为缓存
class ThreadSafeCache:
    def __init__(self, max_size=100):
        self.cache = OrderedDict()
        self.lock = threading.RLock()
        self.max_size = max_size
    
    def get(self, key, default=None):
        with self.lock:
            if key in self.cache:
                # 将访问的项移到末尾，表示最近使用
                value = self.cache.pop(key)
                self.cache[key] = value
                return value
            return default
    
    def set(self, key, value):
        with self.lock:
            # 如果键已存在，先移除它
            if key in self.cache:
                self.cache.pop(key)
            
            # 添加新项
            self.cache[key] = value
            
            # 如果超过最大大小，删除最早的项
            if len(self.cache) > self.max_size:
                self.cache.popitem(last=False)  # 删除第一个项（最早的）
    
    def __contains__(self, key):
        with self.lock:
            return key in self.cache
    
    def __len__(self):
        with self.lock:
            return len(self.cache)
    
    def clear(self):
        with self.lock:
            self.cache.clear()
    
    def keys(self):
        with self.lock:
            return list(self.cache.keys())
    
    def items(self):
        with self.lock:
            return list(self.cache.items())

# 创建线程安全的缓存实例
trade_cache = ThreadSafeCache(max_size=100)

def get_trades_from_raw_frames(sc, start_time, end_time):
    """
    从 brisk_raw_frames 目录下读取指定股票代码和时间范围内的交易数据
    
    参数:
    - sc: 股票代码
    - start_time: 开始时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    - end_time: 结束时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    
    返回:
    - 包含交易数据的列表
    """
    # 转换时间为 datetime 对象
    start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
    end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
    
    # 转换为日本时区 - 使用正确的方式
    jst = pytz.timezone('Asia/Tokyo')
    
    # 确保正确应用时区
    start_dt_jst = start_dt.astimezone(jst)
    end_dt_jst = end_dt.astimezone(jst)
    
    # 检查是否在同一天
    if start_dt_jst.date() != end_dt_jst.date():
        print(f"Warning: start_time and end_time are not on the same day. Only processing the start date: {start_dt_jst.date()}")
        # 将结束时间设置为开始日期的结束
        end_dt_jst = datetime.combine(start_dt_jst.date(), datetime.max.time()).replace(tzinfo=jst)
    
    # 获取日期字符串
    date_str = start_dt_jst.strftime('%Y%m%d')
    
    # 构建缓存键
    cache_key = f"{sc}_{date_str}"
    
    # 检查缓存
    all_trades = trade_cache.get(cache_key)
    if all_trades is not None:
        print(f"Using cached trades for {sc} on {date_str}")
    else:
        # 构建文件名
        filename = f"brisk_frames_{date_str}.json"
        file_path = os.path.join(BRISK_FRAMES_DIR, filename)
        
        # 检查文件是否存在
        if not os.path.exists(file_path):
            print(f"Warning: File {file_path} does not exist")
            return []
        
        # 读取文件内容
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
                # 处理单引号问题 - 去掉首尾的单引号
                content = content[1:len(content)-1]
                
                # 解析 JSON
                data = json.loads(content)
                
                # 检查股票代码是否存在
                if sc not in data:
                    print(f"Warning: Stock code {sc} not found in {filename}")
                    return []
                
                # 获取该股票的所有交易
                stock_trades = data[sc]
                
                # 计算当天 JST 0点的 Unix 时间戳（毫秒）
                # 使用正确的方式创建当天 0 点的时间
                day_start_jst = datetime.combine(start_dt_jst.date(), datetime.min.time())
                # 确保使用 replace 而不是 astimezone 来设置时区
                day_start_jst = jst.localize(day_start_jst)
                day_start_timestamp = int(day_start_jst.timestamp() * 1000)
                
                # print(f"Day start timestamp: {day_start_timestamp}, {day_start_jst.isoformat()}")
                
                # 转换所有交易数据
                all_trades = []
                for trade in stock_trades:
                    # 计算交易的 Unix 时间戳（毫秒）
                    # ts 是从当天 JST 0点开始的微秒数
                    trade_timestamp = day_start_timestamp + (trade["ts"] // 1000)  # 将微秒转换为毫秒
                    
                    # 转换为标准格式
                    formatted_trade = {
                        "id": trade.get("f", 0),  # 使用 f (frame) 作为交易ID
                        "price": trade["p"] / 10,  # 价格（除以10）
                        "quantity": trade["q"],    # 数量
                        "timestamp": trade_timestamp,  # 时间戳（毫秒）
                        # "original_timestamp": trade["ts"],
                        "isBuyerMaker": trade.get("t", 0) == 2  # 1是买，2是卖
                    }
                    all_trades.append(formatted_trade)
                
                # 按 frame 排序
                all_trades.sort(key=lambda x: x["id"])
                
                # 存入缓存
                trade_cache.set(cache_key, all_trades)
                print(f"Cached {len(all_trades)} trades for {sc} on {date_str}, cache size: {len(trade_cache)}")
        
        except Exception as e:
            print(f"Error reading file {file_path}: {str(e)}")
            return []
    
    # 过滤时间范围内的交易
    start_ts = int(start_dt_jst.timestamp() * 1000)
    end_ts = int(end_dt_jst.timestamp() * 1000)
    
    # 使用二分查找找到开始时间的索引
    start_idx = binary_search_trades(all_trades, start_ts)
    
    # 使用二分查找找到结束时间的索引
    end_idx = binary_search_trades(all_trades, end_ts, find_lower=False)
    
    # 返回时间范围内的交易
    return all_trades[start_idx:end_idx]


def binary_search_trades(trades, timestamp, find_lower=True):
    """
    使用二分查找找到大于等于（或小于等于）指定时间戳的第一个交易索引
    
    参数:
    - trades: 交易列表
    - timestamp: 目标时间戳
    - find_lower: 如果为True，找到第一个大于等于时间戳的交易；如果为False，找到最后一个小于等于时间戳的交易
    
    返回:
    - 找到的交易索引
    """
    if not trades:
        return 0
    
    left, right = 0, len(trades) - 1
    
    if find_lower:
        # 找到第一个大于等于时间戳的交易
        while left <= right:
            mid = (left + right) // 2
            if trades[mid]["timestamp"] < timestamp:
                left = mid + 1
            else:
                right = mid - 1
        return left
    else:
        # 找到最后一个小于等于时间戳的交易
        while left <= right:
            mid = (left + right) // 2
            if trades[mid]["timestamp"] <= timestamp:
                left = mid + 1
            else:
                right = mid - 1
        return left


@app.get("/historical-data/{sc}")
async def get_historical_data(sc: str, start_time: str, end_time: str, update_interval: int = None, db: sqlite3.Connection = Depends(get_db)):
    """
    获取指定股票代码在指定时间范围内的历史数据
    
    参数:
    - sc: 股票代码
    - start_time: 开始时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    - end_time: 结束时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    - update_interval: 数据点之间的时间间隔（毫秒），可选
    
    返回:
    - 包含热图数据和交易数据的对象
    """
    try:
        cursor = db.cursor()
        
        # 查询指定时间范围内的数据
        cursor.execute(
            "SELECT frameNum, timestamp, itaString FROM Ita WHERE sc = ? AND timestamp >= ? AND timestamp < ? ORDER BY id ASC",
            (sc, start_time, end_time)
        )
        
        rows = cursor.fetchall()
        
        if not rows:
            return {"heatmapData": [], "tradesData": []}
        
        # 处理查询结果
        heatmap_data = []
        
        for row in rows:
            frame_num, timestamp, ita_string = row
            ita_data = json.loads(ita_string)
            
            # 将 Ita 数据转换为热图数据点
            snapshot = convert_ita_to_snapshot(ita_data)
            
            heatmap_data.append({
                "timestamp": parse_iso_timestamp(timestamp),  # 转换为毫秒时间戳
                "snapshot": snapshot
            })
        
        # 从 brisk_raw_frames 获取交易数据
        trades_data = get_trades_from_raw_frames(sc, start_time, end_time)
        # trades_data = []
        
        # 如果提供了 update_interval 参数，可以在这里实现数据重采样
        # 目前暂时不处理这个逻辑
        
        return {
            "heatmapData": heatmap_data,
            "tradesData": trades_data
        }
        
    except Exception as e:
        print('getting issue while fetching historical data', e)
        raise HTTPException(status_code=500, detail=f"Error fetching historical data: {str(e)}")


def parse_iso_timestamp(timestamp_str):
    """
    解析ISO格式的时间戳，处理带有Z后缀的UTC时间
    返回毫秒级时间戳
    """
    # 处理末尾的Z (UTC标识)
    if timestamp_str.endswith('Z'):
        timestamp_str = timestamp_str[:-1] + '+00:00'
    
    # 解析ISO格式时间戳并转换为毫秒
    return int(datetime.fromisoformat(timestamp_str).timestamp() * 1000)


def convert_ita_to_snapshot(ita_data):
    """
    将 Ita 数据转换为订单簿快照格式
    """
    rows = ita_data.get("rows", [])
    
    # 提取买单和卖单
    bids = []
    asks = []
    
    for row in rows:
        price = row.get("p", 0)
        
        # 处理买单
        if "b" in row and row["b"]:
            bid_quantity = row["b"].get("q", 0)
            if bid_quantity > 0:
                bids.append([str(price), str(bid_quantity)])
        
        # 处理卖单
        if "a" in row and row["a"]:
            ask_quantity = row["a"].get("q", 0)
            if ask_quantity > 0:
                asks.append([str(price), str(ask_quantity)])
    
    # 按价格排序
    bids.sort(key=lambda x: float(x[0]), reverse=True)  # 买单按价格降序
    asks.sort(key=lambda x: float(x[0]))  # 卖单按价格升序
    
    # 创建快照
    snapshot = {
        "lastUpdateId": ita_data.get("frame", 0),
        "bids": bids,
        "asks": asks
    }
    
    return snapshot

@app.get("/raw-trades/{sc}")
async def get_raw_trades(sc: str, start_time: str, end_time: str, limit: int = None):
    """
    测试 API 端点，用于直接从 raw frames 文件中获取交易数据
    
    参数:
    - sc: 股票代码
    - start_time: 开始时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    - end_time: 结束时间 (ISO 格式: YYYY-MM-DDTHH:MM:SS)
    - limit: 返回的最大交易数量，可选
    
    返回:
    - 包含交易数据的列表和统计信息
    """
    try:
        # 记录开始时间，用于性能测量
        start_process_time = time.time()
        
        # 获取交易数据
        trades = get_trades_from_raw_frames(sc, start_time, end_time)
        
        # 计算处理时间
        process_time = time.time() - start_process_time
        
        # 如果指定了 limit，限制返回的交易数量
        if limit and limit > 0:
            limited_trades = trades[:limit]
        else:
            limited_trades = trades
        
        # 计算统计信息
        total_trades = len(trades)
        total_volume = sum(trade["quantity"] for trade in trades)
        buy_volume = sum(trade["quantity"] for trade in trades if not trade["isBuyerMaker"])
        sell_volume = sum(trade["quantity"] for trade in trades if trade["isBuyerMaker"])
        
        # 计算最高价、最低价和平均价
        if trades:
            high_price = max(trade["price"] for trade in trades)
            low_price = min(trade["price"] for trade in trades)
            avg_price = sum(trade["price"] * trade["quantity"] for trade in trades) / total_volume if total_volume > 0 else 0
            first_trade = trades[0]
            last_trade = trades[-1]
        else:
            high_price = low_price = avg_price = 0
            first_trade = last_trade = None
        
        # 返回结果
        return {
            "status": "success",
            "stats": {
                "totalTrades": total_trades,
                "returnedTrades": len(limited_trades),
                "totalVolume": total_volume,
                "buyVolume": buy_volume,
                "sellVolume": sell_volume,
                "highPrice": high_price,
                "lowPrice": low_price,
                "avgPrice": avg_price,
                "processTimeMs": round(process_time * 1000, 2),
                "startTime": start_time,
                "endTime": end_time,
                "firstTradeTime": datetime.fromtimestamp(first_trade["timestamp"]/1000).isoformat() if first_trade else None,
                "lastTradeTime": datetime.fromtimestamp(last_trade["timestamp"]/1000).isoformat() if last_trade else None,
                "cacheStatus": "hit" if sc + "_" + start_time.split("T")[0].replace("-", "") in trade_cache else "miss"
            },
            "trades": limited_trades
        }
    except Exception as e:
        print(f"Error fetching raw trades: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error fetching raw trades: {str(e)}")


@app.get("/cache-status")
async def get_cache_status():
    """
    获取交易缓存的状态信息
    
    返回:
    - 缓存的大小和键列表
    """
    try:
        cache_keys = trade_cache.keys()
        
        # 按日期和股票代码分组
        dates = {}
        stocks = {}
        
        for key in cache_keys:
            parts = key.split('_')
            if len(parts) == 2:
                stock, date = parts
                
                if date not in dates:
                    dates[date] = []
                dates[date].append(stock)
                
                if stock not in stocks:
                    stocks[stock] = []
                stocks[stock].append(date)
        
        return {
            "status": "success",
            "cacheSize": len(trade_cache),
            "maxCacheSize": trade_cache.max_size,
            "cacheKeys": cache_keys,
            "dateGroups": dates,
            "stockGroups": stocks
        }
    except Exception as e:
        print(f"Error getting cache status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting cache status: {str(e)}")


@app.delete("/clear-cache")
async def clear_cache():
    """
    清空交易缓存
    
    返回:
    - 操作状态
    """
    try:
        cache_size_before = len(trade_cache)
        trade_cache.clear()
        
        return {
            "status": "success",
            "message": f"Cache cleared. {cache_size_before} items removed.",
            "cacheSize": len(trade_cache)
        }
    except Exception as e:
        print(f"Error clearing cache: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error clearing cache: {str(e)}")

# 共享数据存储
# 使用线程锁保护共享数据
class SharedDataStore:
    def __init__(self):
        self.data_store = {}  # 存储 req_id -> data 的映射
        self.lock = threading.Lock()
    
    def store_data(self, req_id: str, data: Any) -> None:
        """存储请求数据"""
        with self.lock:
            self.data_store[req_id] = data
            # 可以选择限制存储大小，防止内存泄漏
            if len(self.data_store) > 1000:  # 如果存储超过1000条记录
                # 删除最旧的记录（简单实现）
                oldest_key = next(iter(self.data_store))
                del self.data_store[oldest_key]
    
    def get_data(self, req_id: str) -> Optional[Any]:
        """获取请求数据"""
        with self.lock:
            return self.data_store.get(req_id)
    
    def remove_data(self, req_id: str) -> None:
        """删除请求数据"""
        with self.lock:
            if req_id in self.data_store:
                del self.data_store[req_id]
    
    def get_all_data(self) -> Dict[str, Any]:
        """获取所有数据的副本"""
        with self.lock:
            return self.data_store.copy()

# 创建共享数据存储实例
shared_data_store = SharedDataStore()

# WebSocket 连接管理器
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"Client connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        print(f"Client disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                print(f"Error broadcasting message: {e}")

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                # 解析接收到的 JSON 数据
                json_data = json.loads(data)
                
                # 检查是否包含 req_id 和 data 字段
                if "req_id" in json_data and "data" in json_data:
                    req_id = json_data["req_id"]
                    req_data = json_data["data"]
                    
                    # 存储到共享数据存储中
                    shared_data_store.store_data(req_id, req_data)
                    print(f"Stored data for request ID: {req_id}")
                    
                    # 发送确认消息
                    await websocket.send_text(json.dumps({
                        "type": "ack",
                        "req_id": req_id,
                        "status": "stored"
                    }))
                
            except json.JSONDecodeError:
                print(f"Invalid JSON received: {data}")
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON format"
                }))
            except Exception as e:
                print(f"Error processing message: {e}")
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": str(e)
                }))
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# 添加一个 REST API 端点来访问存储的数据
@app.get("/api/stored-data/{req_id}")
async def get_stored_data(req_id: str):
    data = shared_data_store.get_data(req_id)
    if data is not None:
        return {"req_id": req_id, "data": data}
    else:
        return JSONResponse(
            status_code=404,
            content={"message": f"No data found for request ID: {req_id}"}
        )

# 获取所有存储的数据
@app.get("/api/stored-data")
async def get_all_stored_data():
    return {"data": shared_data_store.get_all_data()}

# 删除特定请求 ID 的数据
@app.delete("/api/stored-data/{req_id}")
async def delete_stored_data(req_id: str):
    shared_data_store.remove_data(req_id)
    return {"message": f"Data for request ID {req_id} has been deleted"}

# # 挂载静态文件
# app.mount("/", StaticFiles(directory="static", html=True), name="static")

# if __name__ == "__main__":
#     import uvicorn
#     uvicorn.run(app, host="0.0.0.0", port=8000)