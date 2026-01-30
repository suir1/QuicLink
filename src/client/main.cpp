#include <QApplication>
#include <QSystemTrayIcon>
#include <QMenu>
#include <QAction>
#include <QMessageBox>
#include <QStyle>  // <--- 关键！之前漏了这一行

int main(int argc, char *argv[])
{
    // init
    QApplication app(argc, argv);

    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        QMessageBox::critical(nullptr, "QuicLink", "System tray is not available on this system.");
        return 1;
    }

    QApplication::setQuitOnLastWindowClosed(false);

    QSystemTrayIcon trayIcon;

    trayIcon.setIcon(app.style()->standardIcon(QStyle::SP_ComputerIcon)); 
    trayIcon.setToolTip("QuicLink - Running");

    QMenu *menu = new QMenu();
    
    QAction *actionConnect = new QAction("Connect to VPS", menu);
    QObject::connect(actionConnect, &QAction::triggered, [](){
        QMessageBox::information(nullptr, "QuicLink", "Connecting logic goes here...");
    });
    
    QAction *actionQuit = new QAction("Quit", menu);
    QObject::connect(actionQuit, &QAction::triggered, &app, &QApplication::quit);

    menu->addAction(actionConnect);
    menu->addSeparator();
    menu->addAction(actionQuit);

    trayIcon.setContextMenu(menu);
    trayIcon.show();

    trayIcon.showMessage("QuicLink", "Client started successfully!", QSystemTrayIcon::Information, 3000);

    return app.exec();
}