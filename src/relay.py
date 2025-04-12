from typing import Dict, Union, List, Optional

from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from pydantic import BaseModel

import csv
from io import StringIO

import json
from datetime import datetime
import sqlite3
import time
import os

# 可配置的常量
DB_PATH = os.environ.get('DB_PATH', 'F:\\kabu\\ita.db')
FRAMES_OUTPUT_DIR = os.environ.get('FRAMES_OUTPUT_DIR', 'D:\\dev\\github\\brisk-hack\\brisk_in_day_frames')

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
    for connection in shared_vars['active_ws_connection']:
        await connection.send_text(f"{command.command} {','.join(command.args)}")
    return ['ok', command.command]


@app.get("/brisk-next-command")
async def get_brisk_next_command(cmd: str, args: str):
    print(cmd, args)
    for connection in shared_vars['active_ws_connection']:
        await connection.send_text(f"{cmd} {args}")
    return ['ok', cmd]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    shared_vars['active_ws_connection'].append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            print(data)
    except WebSocketDisconnect:
        print("Client disconnected")
        shared_vars['active_ws_connection'].remove(websocket)


@app.get("/historical-data/{sc}")
def get_historical_data(sc: str, start_time: str, end_time: str, update_interval: int = None, db: sqlite3.Connection = Depends(get_db)):
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
            "SELECT frameNum, timestamp, itaString FROM Ita WHERE sc = ? AND timestamp BETWEEN ? AND ? ORDER BY id ASC",
            (sc, start_time, end_time)
        )
        
        rows = cursor.fetchall()
        
        if not rows:
            return {"heatmapData": [], "tradesData": []}
        
        # 处理查询结果
        heatmap_data = []
        trades_data = []
        
        for row in rows:
            frame_num, timestamp, ita_string = row
            ita_data = json.loads(ita_string)
            
            # 将 Ita 数据转换为热图数据点
            snapshot = convert_ita_to_snapshot(ita_data)
            
            heatmap_data.append({
                "timestamp": parse_iso_timestamp(timestamp),  # 转换为毫秒时间戳
                "snapshot": snapshot
            })
            
            # 从 Ita 数据中提取交易数据
            trades = extract_trades_from_ita(ita_data, timestamp)
            trades_data.extend(trades)
        
        # 如果提供了 update_interval 参数，可以在这里实现数据重采样
        # 目前暂时不处理这个逻辑
        
        return {
            "heatmapData": heatmap_data,
            "tradesData": trades_data
        }
        
    except Exception as e:
        print('getting isuee while fetching historical data', e)
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


def extract_trades_from_ita(ita_data, timestamp):
    """
    从 Ita 数据中提取交易数据
    注意：实际的交易数据可能需要从其他来源获取
    这里只是一个示例，根据订单簿变化模拟交易
    """
    trades = []
    frame = ita_data.get("frame", 0)
    
    # 这里只是一个简化的示例
    # 实际上，您可能需要比较前后两个订单簿快照来推断交易
    # 或者从其他数据源获取实际的交易数据
    
    # 将时间戳转换为毫秒
    ts = parse_iso_timestamp(timestamp)
    
    return trades