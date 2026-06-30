cmake_minimum_required(VERSION 3.10)
project(urdf_tcp_controller)

set(CMAKE_CXX_STANDARD 17)

add_executable(urdf_controller urdf_tcp_controller.cpp)

# Linux 需要 pthread
if(UNIX AND NOT APPLE)
    target_link_libraries(urdf_controller pthread)
endif()
