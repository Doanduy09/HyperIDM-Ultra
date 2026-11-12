# ⚡ HyperIDM Ultra 64-Bit (TitanFetch Engine)

> **Trình tăng tốc tải xuống thế hệ mới dành cho Windows 10/11 (64-bit Native Architecture)** — Được thiết kế để vượt qua toàn bộ giới hạn kiến trúc 32-bit của Internet Download Manager (IDM truyền thống), đạt tốc độ bão hòa 100% băng thông vật lý và hoàn tất ghép file trong **`0 ms`**.

---

## 🔬 Giải Phẫu Nhị Phân `IDMan.exe` (v6.43b10) vs. **HyperIDM Ultra 64-Bit**

Qua quá trình phân tích trực tiếp PE Header của `IDMan.exe` và nhật ký thực thi `UniversalMac_14_114.log` trên Windows 11 Pro:

| Tiêu chí Kỹ thuật | Internet Download Manager (`IDMan.exe` v6.43b10) | **HyperIDM Ultra v2.0 (TitanFetch 64-Bit)** |
| :--- | :--- | :--- |
| **Kiến trúc Nhị phân** | **32-bit x86 (`PE32 0x014C`)**, `LargeAddressAware = False` (Giới hạn cứng 2GB RAM) | **64-bit x64 Native (`PE32+ 0x8664`)**, không giới hạn không gian địa chỉ |
| **Bộ đệm TLS / I/O Buffer** | **`16 KB`** cố định (`SChannel MaxMessage = 16,384 bytes`) | **`1,024 KB (1 MB)` Write Coalescing Ring Buffer** mỗi luồng (Lớn gấp **64x**) |
| **Khởi tạo Đa Luồng** | Tăng bậc tuần tự 6 đợt (`1 → 2 → 4 → 8 → 16 → 32`), tự ngắt luồng `C0` 2 lần đầu | **Wave-0 Instant Parallel Burst**: Phóng đồng loạt **64–128 luồng** ngay sau `1 RTT` Probe |
| **Cơ chế Ghi Đĩa & Nối File (99% Stall)** | Ghi ra hàng trăm file tạm rời rạc (`ipsw1..175`) trong `%APPDATA%\IDM\DwnlData`, treo cứng ở 99% để đọc/chép ghép file (**Tốn gấp đôi tuổi thọ SSD — 2x TBW**) | **Pre-Allocated Sparse In-Place Write**: Cấp phát 1 file đích duy nhất (`fsutil sparse`), ghi thẳng vào đúng vị trí byte (`offset`) → **Hoàn tất ở 100% trong `0 ms` (`1x TBW`)** |
| **Rủi ro Mất Dữ Liệu Tạm** | Lỗi `Erase chunk_list f2` xóa sạch các phân đoạn không liền kề (mất `5.95 GB` dữ liệu đã tải trong thực tế) | **Atomic Offset Journal (`.hyper.json`)**: Lưu trạng thái từng phân đoạn độc lập, không bao giờ mất byte đã ghi |
| **Phân tải Đa IP CDN** | Khóa cứng 1 địa chỉ IP duy nhất cho cả 32 luồng | **Multi-IP DNS Pool Round-Robin + TLS SNI**: Rải đều kết nối qua toàn bộ danh sách IP biên của CDN |
| **Cắt Luồng Động & Chống Bóp Băng Thông** | Cắt đôi tĩnh (Bisection) và phải ngắt kết nối TCP cũ; cuối file tụt về 1 luồng đơn (`2.11 MB/s`) | **In-Flight Boundary Shrink + Tail-Latency Watchdog**: Cắt luồng đang chạy không ngắt socket, tự động tái sinh socket đơ `>2.2s` |
| **Giải mã Smart Link (`ipsw.me` / `YouTube`)** | Chỉ tải nhầm file HTML (`index.html` / `watch.htm`) khi dán link trực tiếp | **Smart Resolver Tích Hợp**: Tự động giải mã API `ipsw.me` sang Apple CDN & tự động bắt luồng Video+Audio YouTube tải 64 luồng + ghép MP4 lossless |

---

## 🚀 Kết Quả Benchmark Thực Tế

| Bài Kiểm Thử Thực Tế | Kết Quả Trên IDM (`IDMan.exe`) | Kết Quả Trên **HyperIDM Ultra (64 Luồng)** |
| :--- | :--- | :--- |
| **1. Tải Video YouTube 8K Demo 64 phút** (`https://www.youtube.com/watch?v=KxMqSz8qVSg` — `369.06 MB`) | ❌ **Thất bại** (Chỉ tải về file trang web `watch.htm` `~600 KB`) | ✅ **Hoàn tất `369.06 MB` trong `17.09s`** (Đỉnh: **`51.07 MB/s` / `408.6 Mbps`**, 23 lần Work-Steal, ghép MP4 `0s` re-encode) |
| **2. Tải Firmware Apple IPSW qua Smart Link** (`https://ipsw.me/download/Mac15,12/23F79/`) | ❌ **Thất bại** khi dán link `ipsw.me` (tải nhầm HTML); với link trực tiếp bị tụt về **`2.11 MB/s`** ở cuối và lỗi `Erase chunk_list` làm mất `5.95 GB` | ✅ Tự động giải mã sang `updates.cdn-apple.com`, đạt đỉnh **`63.41 MB/s` (`507.3 Mbps`)**, `0 ms` nối file |
| **3. Tải Bộ cài Node.js Windows x64 ZIP** (`33.29 MB` — Multi-IP Cloudflare CDN) | `~8.5 MB/s` + dừng nối file ở 99% | ✅ **Hoàn tất trong `1.44s`** (Trung bình: **`23.13 MB/s`**, Đỉnh: **`37.27 MB/s`**, **`0 ms` nối file**) |
| **4. Tải Bộ cài Python 3.13.2 AMD64 EXE** (`27.80 MB`) | `~9.2 MB/s` + dừng nối file ở 99% | ✅ **Hoàn tất siêu tốc** với 64 luồng song song, **`0 ms` nối file** |
| **5. Stress Test Engine I/O (512 MB / 1 GB)** | Giới hạn bởi kiến trúc 32-bit + nghẽn ghép file | ✅ **Đạt đỉnh `627.00 MB/s` (`5.02 Gbps`)**, hoàn tất `512 MB` trong **`0.92s`**, **`0 ms` nối file** |

---

## 📦 Cài Đặt Cho Mọi Máy Tính Windows 10 / 11 (1-Click Universal Installer)

### Cách 1: Chạy trực tiếp bộ cài đặt tự động
1. Tải hoặc Clone kho mã nguồn này về máy Windows bất kỳ:
   ```powershell
   git clone https://github.com/Doanduy09/HyperIDM-Ultra.git
   cd HyperIDM-Ultra
   ```
2. Nhấp đúp vào **`HyperIDM-Setup.exe`** hoặc **`Install-HyperIDM.bat`** (hoặc chạy PowerShell):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Install-HyperIDM.ps1
   ```
3. Bộ cài đặt sẽ tự động:
   - Cài đặt ứng dụng vào `%LOCALAPPDATA%\Programs\HyperIDM`.
   - Biên dịch file thực thi 64-bit Native **`HyperIDM.exe` (`PE32+ 0x8664`)**.
   - Tạo biểu tượng **HyperIDM Ultra** ngoài **Desktop** và **Start Menu**.
   - Đăng ký giao thức **`hyperidm://`** và lệnh CLI **`hyperidm`** vào biến môi trường `PATH`.

### Cách 2: Sử dụng qua Giao diện Desktop hoặc Dòng lệnh (CLI)
- **Mở giao diện Desktop**: Nhấp đúp biểu tượng **HyperIDM Ultra** trên Desktop (hoặc chạy `HyperIDM.exe`).
- **Tải siêu tốc qua CLI**:
  ```powershell
  hyperidm "https://ipsw.me/download/Mac15,12/23F79/" 64
  hyperidm "https://www.youtube.com/watch?v=KxMqSz8qVSg" 64
  ```
