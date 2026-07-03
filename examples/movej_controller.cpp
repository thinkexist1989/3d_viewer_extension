/**
 * movej_controller.cpp
 *
 * MoveJ 关节空间运动控制 + 梯形速度规划。
 * 封装 RobotClient 类，提供简洁的 MoveJ(vector<double>) 接口。
 *
 * 编译：
 *   g++ -std=c++17 -o movej_controller movej_controller.cpp -pthread
 *
 * 用法：
 *   ./movej_controller [port]
 */

#include <iostream>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include <sstream>
#include <map>
#include <chrono>
#include <thread>
#include <algorithm>
#include <iomanip>

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

// ===================================================================
//  关节类型 & 定义
// ===================================================================

enum class JointType { Revolute, Prismatic, Continuous, Fixed };

const char* jointTypeName(JointType t) {
    switch (t) {
        case JointType::Revolute:   return "revolute";
        case JointType::Prismatic:  return "prismatic";
        case JointType::Continuous: return "continuous";
        case JointType::Fixed:      return "fixed";
        default: return "unknown";
    }
}

struct JointInfo {
    std::string name;
    JointType  type;
    double     minLimit;
    double     maxLimit;
    double     maxVelocity;   // rad/s 或 m/s
    double     maxAccel;      // rad/s² 或 m/s²
    double     position;

    bool isRotational() const {
        return type == JointType::Revolute || type == JointType::Continuous;
    }
    const char* unit() const { return isRotational() ? "rad" : "m"; }
};

// ===================================================================
//  梯形速度轨迹（单轴）
// ===================================================================

struct TrapezoidProfile {
    double qStart, qEnd;
    double vMax, aMax;
    double totalTime;
    double tAccel, tDecelStart;
    double cruiseSpeed;
    double signDir;

    /// 规划。forcedDuration > 0 时拉伸到该时长（多轴同步）。
    double plan(double start, double end, double maxV, double maxA,
                double forcedDuration = 0.0) {
        qStart = start;
        qEnd   = end;
        vMax   = maxV;
        aMax   = maxA;

        double dq    = qEnd - qStart;
        signDir      = (dq >= 0) ? 1.0 : -1.0;
        double absDq = std::abs(dq);

        double tA = vMax / aMax;
        double dA = 0.5 * aMax * tA * tA;   // 加速距离

        double tTotal;
        if (absDq < 2.0 * dA) {
            // 三角形：达不到 vMax
            cruiseSpeed  = std::sqrt(absDq * aMax);
            tAccel       = cruiseSpeed / aMax;
            tDecelStart  = tAccel;
            tTotal       = 2.0 * tAccel;
        } else {
            // 完整梯形
            cruiseSpeed  = vMax;
            tAccel       = tA;
            double cruiseDist = absDq - 2.0 * dA;
            double tCruise    = cruiseDist / vMax;
            tDecelStart  = tA + tCruise;
            tTotal       = 2.0 * tA + tCruise;
        }

        if (forcedDuration > 0.0 && forcedDuration > tTotal) {
            return stretch(forcedDuration);
        }
        totalTime = tTotal;
        return totalTime;
    }

    double position(double t) const {
        if (t <= 0) return qStart;
        if (t >= totalTime) return qEnd;
        if (t < tAccel) {
            return qStart + signDir * 0.5 * aMax * t * t;
        } else if (t < tDecelStart) {
            double qAtAccel = qStart + signDir * 0.5 * aMax * tAccel * tAccel;
            return qAtAccel + signDir * cruiseSpeed * (t - tAccel);
        } else {
            double tRemain = totalTime - t;
            return qEnd - signDir * 0.5 * aMax * tRemain * tRemain;
        }
    }

private:
    double stretch(double T) {
        totalTime   = T;
        double absDq = std::abs(qEnd - qStart);
        double ratio = 0.3;
        tAccel       = ratio * T;
        tDecelStart  = T - tAccel;
        cruiseSpeed  = absDq / (T - tAccel);
        aMax         = cruiseSpeed / tAccel;
        return T;
    }
};

// ===================================================================
//  MoveJ 多轴同步规划器
// ===================================================================

class MoveJPlanner {
public:
    std::vector<JointInfo>       joints;
    std::vector<TrapezoidProfile> profiles;
    double speedFactor = 1.0;
    double loopDt;
    double totalTime = 0;

    MoveJPlanner(double frequency = 100.0) : loopDt(1.0 / frequency) {}

    /// 规划到目标位置，返回总时间
    double plan(const std::map<std::string, double>& targets) {
        profiles.resize(joints.size());
        totalTime = 0;

        // 第一遍：各自规划，找主导轴
        for (size_t i = 0; i < joints.size(); ++i) {
            auto it = targets.find(joints[i].name);
            double target = (it != targets.end())
                ? clamp(joints[i], it->second)
                : joints[i].position;
            double v = joints[i].maxVelocity * speedFactor;
            double a = joints[i].maxAccel * speedFactor;
            double t = profiles[i].plan(joints[i].position, target, v, a);
            if (t > totalTime) totalTime = t;
        }

        // 第二遍：非主导轴拉伸到主导轴时长
        for (size_t i = 0; i < joints.size(); ++i) {
            double target = profiles[i].qEnd;
            double v = joints[i].maxVelocity * speedFactor;
            double a = joints[i].maxAccel * speedFactor;
            profiles[i].plan(joints[i].position, target, v, a, totalTime);
        }
        return totalTime;
    }

    std::map<std::string, double> stateAt(double t) const {
        std::map<std::string, double> s;
        for (size_t i = 0; i < joints.size(); ++i)
            s[joints[i].name] = profiles[i].position(t);
        return s;
    }

    void updatePositions(const std::map<std::string, double>& state) {
        for (auto& j : joints) {
            auto it = state.find(j.name);
            if (it != state.end()) j.position = it->second;
        }
    }

private:
    double clamp(const JointInfo& j, double v) const {
        return std::max(j.minLimit, std::min(j.maxLimit, v));
    }
};

// ===================================================================
//  RobotClient — 封装 TCP + MoveJ
// ===================================================================

class RobotClient {
public:
    RobotClient() = default;
    ~RobotClient() { disconnect(); }

    /// 连接到插件 TCP 服务器
    bool connect(const std::string& host = "127.0.0.1", int port = 50051) {
#ifdef _WIN32
        WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
        sock_ = socket(AF_INET, SOCK_STREAM, 0);
        if (sock_ == INVALID_SOCK) return false;

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port   = htons(static_cast<uint16_t>(port));
        inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

        if (::connect(sock_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCK_ERR) {
            CLOSESOCK(sock_);
            sock_ = INVALID_SOCK;
            return false;
        }
        return true;
    }

    void disconnect() {
        if (sock_ != INVALID_SOCK) { CLOSESOCK(sock_); sock_ = INVALID_SOCK; }
    }

    bool isConnected() const { return sock_ != INVALID_SOCK; }

    /// 初始化关节定义（名称、类型、限位、速度、加速度）
    void setJoints(const std::vector<JointInfo>& j) {
        planner_.joints = j;
    }

    /// 获取关节数量
    int jointCount() const { return static_cast<int>(planner_.joints.size()); }

    /// 设置全局速度比例 (0.0 ~ 1.0)
    void setSpeedFactor(double f) { planner_.speedFactor = f; }

    /// 打印当前关节状态
    void printState() const {
        std::cout << std::fixed << std::setprecision(4);
        for (size_t i = 0; i < planner_.joints.size(); ++i) {
            const auto& j = planner_.joints[i];
            std::cout << "  [" << i << "] " << std::setw(12) << std::left << j.name
                      << " [" << jointTypeName(j.type) << "]"
                      << "  pos=" << std::setw(8) << j.position << " " << j.unit()
                      << std::endl;
        }
    }

    /**
     * MoveJ — 关节空间运动
     * @param targets  目标关节值，按 setJoints 顺序排列，长度必须等于关节数
     * @return         规划总时长 (秒)
     *
     * 示例:
     *   robot.MoveJ({0.5, -0.3, 0.8, -0.6, 0.4, -0.7, 0.3});
     */
    double MoveJ(const std::vector<double>& targets) {
        if (targets.size() != planner_.joints.size()) {
            std::cerr << "[MoveJ] 错误: targets 数量 (" << targets.size()
                      << ") ≠ 关节数 (" << planner_.joints.size() << ")" << std::endl;
            return 0;
        }

        // 构造 name → target 映射
        std::map<std::string, double> targetMap;
        for (size_t i = 0; i < planner_.joints.size(); ++i) {
            targetMap[planner_.joints[i].name] = targets[i];
        }

        // 打印目标
        std::cout << "\n── MoveJ ──" << std::endl;
        std::cout << "  目标: ";
        for (size_t i = 0; i < targets.size(); ++i) {
            std::cout << planner_.joints[i].name << "=" << targets[i];
            if (i < targets.size() - 1) std::cout << ", ";
        }
        std::cout << std::endl;

        // 规划
        double duration = planner_.plan(targetMap);
        std::cout << "  规划时长: " << duration << " s  @ "
                  << (1.0 / planner_.loopDt) << " Hz" << std::endl;

        // 执行
        executeTrajectory(duration);

        std::cout << "  ✓ 完成" << std::endl;
        return duration;
    }

private:
    void sendJson(const std::map<std::string, double>& state) {
        std::ostringstream oss;
        oss << "{";
        bool first = true;
        for (const auto& [name, pos] : state) {
            if (!first) oss << ",";
            oss << "\"" << name << "\":" << pos;
            first = false;
        }
        oss << "}\n";
        std::string line = oss.str();

        size_t total = 0;
        while (total < line.size()) {
            auto n = send(sock_, line.c_str() + total,
                          static_cast<int>(line.size() - total), 0);
            if (n <= 0) return;
            total += static_cast<size_t>(n);
        }
    }

    void executeTrajectory(double duration) {
        auto t0  = std::chrono::steady_clock::now();
        int  steps = static_cast<int>(std::ceil(duration / planner_.loopDt));
        int  frame = 0;

        for (int step = 0; step <= steps; ++step) {
            auto now = std::chrono::steady_clock::now();
            double t = std::chrono::duration<double>(now - t0).count();
            if (t > duration) t = duration;

            auto state = planner_.stateAt(t);
            sendJson(state);
            planner_.updatePositions(state);

            if (frame++ % 10 == 0 || step == steps) {
                double pct = duration > 0 ? t / duration * 100 : 100;
                std::cout << "\r  进度: " << std::fixed << std::setprecision(1)
                          << pct << "%  t=" << std::setprecision(3) << t << "s"
                          << std::flush;
            }

            auto elapsed = std::chrono::steady_clock::now() - now;
            auto sleepUs = static_cast<int>(planner_.loopDt * 1e6)
                - static_cast<int>(std::chrono::duration_cast<std::chrono::microseconds>(elapsed).count());
            if (sleepUs > 0)
                std::this_thread::sleep_for(std::chrono::microseconds(sleepUs));
        }
        std::cout << std::endl;
    }

    sock_t       sock_ = INVALID_SOCK;
    MoveJPlanner planner_{100.0};
};

// ===================================================================
//  main — 使用 MoveJ 测试
// ===================================================================

int main(int argc, char* argv[]) {
    int port = (argc >= 2) ? std::stoi(argv[1]) : 50051;

    std::cout << "========================================" << std::endl;
    std::cout << "  MoveJ Controller (梯形速度规划)" << std::endl;
    std::cout << "========================================" << std::endl;

    // 1. 创建机器人客户端
    RobotClient robot;

    // 2. 定义关节（顺序决定 MoveJ 参数顺序）
    robot.setJoints({
        // name       type                    min     max   vMax  aMax  pos
        {"joint_1", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_2", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_3", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_4", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_5", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_6", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
        {"joint_7", JointType::Revolute,     -3.14,  3.14,  2.0,  4.0,  0.0},
    });

    // 3. 连接
    if (!robot.connect("127.0.0.1", port)) {
        std::cerr << "[ERROR] 无法连接 TCP :" << port << std::endl;
        std::cerr << "  请先启动 VS Code 插件并点击 Start TCP" << std::endl;
        return 1;
    }
    std::cout << "[INFO] 已连接到机器人" << std::endl;

    // 4. MoveJ 测试序列
    std::cout << "\n初始状态:" << std::endl;
    robot.printState();

    // 各关节值顺序对应 setJoints 的顺序:
    //   joint_1, joint_2, joint_3, joint_4, joint_5, joint_6, joint_7
    robot.MoveJ({ 0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0});  // 零位

    robot.MoveJ({ 0.5, -0.3,  0.8, -0.6,  0.4, -0.7,  0.3});  // 抓取预备

    robot.MoveJ({ 1.0,  0.2,  0.4, -0.2, -0.5, -0.3,  0.8});  // 接近

    robot.MoveJ({ 1.5,  0.8, -0.2,  0.3, -1.0,  0.1,  1.2});  // 目标

    robot.MoveJ({ 0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0});  // 回零

    std::cout << "\n========== 测试完成 ==========" << std::endl;
    return 0;
}
