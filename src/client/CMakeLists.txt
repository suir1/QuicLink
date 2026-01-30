cmake_minimum_required(VERSION 3.16)

project(QuicLinkClient LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets Network WebSockets)

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/network
    ${CMAKE_CURRENT_SOURCE_DIR}/services
    ${CMAKE_CURRENT_SOURCE_DIR}/ui
    ${CMAKE_CURRENT_SOURCE_DIR}/utils
)

file(GLOB_RECURSE SOURCES
    "*.cpp"
    "*.h"
)

add_executable(QuicLinkClient ${SOURCES})

# 链接库
target_link_libraries(QuicLinkClient PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::Network
    Qt6::WebSockets
)

if(APPLE)
    set_target_properties(QuicLinkClient PROPERTIES MACOSX_BUNDLE ON)
endif()
