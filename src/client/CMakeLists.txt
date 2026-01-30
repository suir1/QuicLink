
add_executable(QuicLinkClient
    main.cpp
)

target_link_libraries(QuicLinkClient PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::Network
)

if(WIN32)
    set_target_properties(QuicLinkClient PROPERTIES WIN32_EXECUTABLE ON)
endif()