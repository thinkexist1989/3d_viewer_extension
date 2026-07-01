/**
 * urdf_tcp_controller.cpp
 *
 * 连接到 VS Code 插件的 TCP 服务器，发送 JSON 关节角度控制 URDF 模型运动。
 * 使用方法
1. 编译：


cd examples
g++ -std=c++17 -o urdf_controller urdf_tcp_controller.cpp -pthread
或用 CMake：


cd examples && mkdir build && cd build && cmake .. && make
2. 运行两种模式：

正弦波自动演示模式（默认） — 各关节自动做正弦波运动：


./urdf_controller           # 默认端口 50051
./urdf_controller 50051     # 指定端口
手动输入模式 — 逐个控制关节角度：


./urdf_controller 50051 manual

joints> joint_1 0.5        # 设置 joint_1 为 0.5 rad
joints> all 1.0             # 所有关节设为 1.0 rad
joints> show                # 显示所有角度
joints> joint_3             # 查看单个关节
joints> quit                # 退出
3. 与插件配合使用流程：

VS Code 中按 F5 启动插件
加载一个 URDF 模型（如 talon_description/urdf/Talon.SLDASM.urdf）
点击底部胶囊工具栏的 Joints 按钮打开关节面板
点击面板中的 Start TCP 按钮启动 TCP 服务器（端口 50051）
终端中运行 ./urdf_controller，机械臂会自动做正弦波运动
也可以同时用面板上的滑动条手动控制关节
 * mode: sine (默认正弦波演示) | manual (手动输入)
 */

#include <iostream>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include <sstream>
#include <chrono>
#include <thread>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #pragma comment(lib, "ws2_32.lib")
  using sock_t = SOCKET;
  constexpr sock_t INVALID_SOCK = INVALID_SOCKET;
  constexpr int SOCK_ERR = SOCKET_ERROR;
  #define CLOSESOCK closesocket
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  #include <fcntl.h>
  #define CLOSESOCK close
  using sock_t = int;
  constexpr sock_t INVALID_SOCK = -1;
  constexpr int SOCK_ERR = -1;
#endif

struct JointState {
    std::string name;
    double angle;     // radians
    double minLimit;  // radians
    double maxLimit;  // radians
    double velocity;  // rad/s（用于正弦演示的频率缩放）
};

// 所有关节定义（对应 Talon 7-DOF 机械臂）
std::vector<JointState> joints = {
    {"joint_1", 0.0, -3.14, 3.14, 1.0},
    {"joint_2", 0.0, -3.14, 3.14, 0.8},
    {"joint_3", 0.0, -3.14, 3.14, 1.2},
    {"joint_4", 0.0, -3.14, 3.14, 0.6},
    {"joint_5", 0.0, -3.14, 3.14, 1.5},
    {"joint_6", 0.0, -3.14, 3.14, 0.9},
    {"joint_7", 0.0, -3.14, 3.14, 1.1},
};

// ---------- JSON 工具 ----------

std::string anglesToJson(const std::vector<JointState>& js) {
    std::ostringstream oss;
    oss << "{";
    for (size_t i = 0; i < js.size(); ++i) {
        if (i > 0) oss << ",";
        oss << "\"" << js[i].name << "\":" << js[i].angle;
    }
    oss << "}";
    return oss.str();
}

// ---------- 网络 ----------

sock_t connectToServer(const char* host, int port) {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    sock_t sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock == INVALID_SOCK) {
        std::cerr << "[ERROR] socket() failed" << std::endl;
        return INVALID_SOCK;
    }

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    inet_pton(AF_INET, host, &addr.sin_addr);

    std::cout << "[INFO] 连接到 " << host << ":" << port << " ..." << std::endl;
    if (connect(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCK_ERR) {
        std::cerr << "[ERROR] connect() failed" << std::endl;
        CLOSESOCK(sock);
        return INVALID_SOCK;
    }
    std::cout << "[INFO] 已连接!" << std::endl;
    return sock;
}

bool sendMessage(sock_t sock, const std::string& msg) {
    std::string line = msg + "\n";
    size_t total = 0;
    while (total < line.size()) {
        auto sent = send(sock, line.c_str() + static_cast<int>(total),
                         static_cast<int>(line.size() - total), 0);
        if (sent <= 0) return false;
        total += static_cast<size_t>(sent);
    }
    return true;
}

// 非阻塞接收，返回空字符串表示无数据
std::string tryReceive(sock_t sock) {
    char buf[4096] = {};
#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(sock, FIONBIO, &mode);
#else
    int flags = fcntl(sock, F_GETFL, 0);
    fcntl(sock, F_SETFL, flags | O_NONBLOCK);
#endif
    auto n = recv(sock, buf, sizeof(buf) - 1, 0);
#ifdef _WIN32
    mode = 0;
    ioctlsocket(sock, FIONBIO, &mode);
#else
    fcntl(sock, F_SETFL, flags);
#endif
    if (n > 0) {
        buf[n] = '\0';
        return std::string(buf);
    }
    return "";
}

bool hasData(sock_t sock, int timeoutMs = 10) {
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(sock, &fds);
    timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = timeoutMs * 1000;
    return select(static_cast<int>(sock) + 1, &fds, nullptr, nullptr, &tv) > 0;
}

// ---------- 控制模式 ----------

void runSineMode(sock_t sock, double frequency = 0.5) {
    std::cout << "\n[MODE] 正弦波演示 (按 Ctrl+C 退出)\n"
              << "  频率: " << frequency << " Hz\n"
              << "  关节数: " << joints.size() << "\n" << std::endl;

    auto startTime = std::chrono::steady_clock::now();
    const int hz = 60;
    const double dt = 1.0 / hz;
    int frame = 0;

    while (true) {
        auto now = std::chrono::steady_clock::now();
        double t = std::chrono::duration<double>(now - startTime).count();

        // 每个关节用不同的振幅和相位生成正弦运动
        for (size_t i = 0; i < joints.size(); ++i) {
            double amplitude = 0.8 + 0.4 * static_cast<double>(i) / joints.size();
            double phase = i * 0.7;
            double freq = frequency * joints[i].velocity;

            joints[i].angle = amplitude * sin(2.0 * M_PI * freq * t + phase);
            joints[i].angle = std::max(joints[i].minLimit,
                              std::min(joints[i].maxLimit, joints[i].angle));
        }

        // 发送
        std::string json = anglesToJson(joints);
        if (!sendMessage(sock, json)) {
            std::cerr << "\n[ERROR] 发送失败，连接可能已断开" << std::endl;
            break;
        }

        // 接收插件回复
        if (hasData(sock)) {
            std::string reply = tryReceive(sock);
            if (!reply.empty()) {
                std::cout << "\n[RX] " << reply << std::endl;
            }
        }

        // 打印当前角度
        if (frame++ % 30 == 0) {
            std::cout << "\r[t=" << t << "s]  ";
            for (const auto& j : joints) {
                char buf[32];
                snprintf(buf, sizeof(buf), "%s=%.2f  ", j.name.c_str(), j.angle);
                std::cout << buf;
            }
            std::cout << "   " << std::flush;
        }

        // 控制发送频率
        auto elapsed = std::chrono::steady_clock::now() - now;
        auto sleepUs = static_cast<int>(dt * 1e6) -
                       static_cast<int>(std::chrono::duration_cast<std::chrono::microseconds>(elapsed).count());
        if (sleepUs > 0) {
            std::this_thread::sleep_for(std::chrono::microseconds(sleepUs));
        }
    }
}

void runManualMode(sock_t sock) {
    std::cout << "\n[MODE] 手动输入\n"
              << "  格式: joint_name angle\n"
              << "  例如: joint_1 0.5\n"
              << "  输入 'all 0' 重置所有关节\n"
              << "  输入 'show' 显示所有关节角度\n"
              << "  输入 'send' 立即发送当前状态\n"
              << "  输入 'quit' 退出\n" << std::endl;

    for (auto& j : joints) j.angle = 0.0;

    std::string line;
    while (true) {
        std::cout << "joints> " << std::flush;
        if (!std::getline(std::cin, line)) break;

        // trim
        auto l = line.find_first_not_of(" \t");
        auto r = line.find_last_not_of(" \t");
        if (l == std::string::npos) continue;
        line = line.substr(l, r - l + 1);

        if (line == "quit" || line == "exit") break;

        if (line == "show") {
            for (const auto& j : joints) {
                char buf[64];
                snprintf(buf, sizeof(buf), "  %-12s = %7.3f rad", j.name.c_str(), j.angle);
                std::cout << buf << std::endl;
            }
            continue;
        }

        if (line == "send") {
            std::string json = anglesToJson(joints);
            sendMessage(sock, json);
            std::cout << "[TX] " << json << std::endl;
            continue;
        }

        std::istringstream iss(line);
        std::string name;
        double value;
        iss >> name;

        if (name == "all") {
            if (iss >> value) {
                for (auto& j : joints) {
                    j.angle = std::max(j.minLimit, std::min(j.maxLimit, value));
                }
                std::cout << "  所有关节设为 " << value << " rad" << std::endl;
            } else {
                continue;
            }
        } else {
            if (!(iss >> value)) {
                // 只输入了关节名，打印当前值
                bool found = false;
                for (const auto& j : joints) {
                    if (j.name == name) {
                        std::cout << "  " << j.name << " = " << j.angle << " rad" << std::endl;
                        found = true;
                        break;
                    }
                }
                if (!found) std::cout << "  未知关节: " << name << std::endl;
                continue;
            }

            bool found = false;
            for (auto& j : joints) {
                if (j.name == name) {
                    j.angle = std::max(j.minLimit, std::min(j.maxLimit, value));
                    std::cout << "  " << j.name << " = " << j.angle << " rad" << std::endl;
                    found = true;
                    break;
                }
            }
            if (!found) {
                std::cout << "  未知关节: " << name << std::endl;
                continue;
            }
        }

        // 自动发送
        std::string json = anglesToJson(joints);
        sendMessage(sock, json);
        std::cout << "[TX] " << json << std::endl;

        // 接收回复
        if (hasData(sock, 100)) {
            std::string reply = tryReceive(sock);
            if (!reply.empty()) {
                std::cout << "[RX] " << reply << std::endl;
            }
        }
    }
}

// ---------- main ----------

int main(int argc, char* argv[]) {
    int port = 50051;
    std::string mode = "sine";

    if (argc >= 2) {
        port = std::stoi(argv[1]);
    }
    if (argc >= 3) {
        mode = argv[2];
    }

    std::cout << "========================================" << std::endl;
    std::cout << "  URDF Joint Controller" << std::endl;
    std::cout << "  端口: " << port << std::endl;
    std::cout << "  模式: " << mode << std::endl;
    std::cout << "========================================" << std::endl;

    sock_t sock = connectToServer("192.168.137.1", port);
    if (sock == INVALID_SOCK) {
        std::cerr << "[ERROR] 无法连接到服务器" << std::endl;
        std::cerr << "  请确保 VS Code 插件的 TCP 服务器已启动。" << std::endl;
        std::cerr << "  在插件中加载 URDF 后，点击 Joints 按钮，再点击 Start TCP。" << std::endl;
        return 1;
    }

    if (mode == "manual") {
        runManualMode(sock);
    } else {
        runSineMode(sock);
    }

    CLOSESOCK(sock);
#ifdef _WIN32
    WSACleanup();
#endif
    std::cout << "\n[INFO] 已断开连接" << std::endl;
    return 0;
}
