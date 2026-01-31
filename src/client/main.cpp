#include <QApplication>
#include <QDebug>
#include <QObject>

#include "network/SignalingClient.h"
int main(int argc, char* argv[]) {
  QApplication app(argc, argv);

  qDebug() << "🚀 QuicLink Client Starting...";

  SignalingClient client;

  QString serverUrl = "ws://yourip/ws?room=test_room";

  client.connectToServer(serverUrl);

  return app.exec();
}
