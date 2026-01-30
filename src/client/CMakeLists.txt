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

file(GLOB_RECURSE NETWORK_SRC "network/*.cpp" "network/*.h")
file(GLOB_RECURSE SERVICES_SRC "services/*.cpp" "services/*.h")
file(GLOB_RECURSE UI_SRC "ui/*.cpp" "ui/*.h")
file(GLOB_RECURSE UTILS_SRC "utils/*.cpp" "utils/*.h")

set(SOURCES
    main.cpp
    ${NETWORK_SRC}
    ${SERVICES_SRC}
    ${UI_SRC}
    ${UTILS_SRC}
)

add_executable(QuicLinkClient ${SOURCES})

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
