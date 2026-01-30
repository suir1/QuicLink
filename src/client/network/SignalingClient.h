#ifndef SIGNALINGCLIENT_H
#define SIGNALINGCLIENT_H

#include <QObject>
#include <QUrl>
#include <QWebSocket>

class SignalingClient : public QObject {
  Q_OBJECT
 public:
  explicit SignalingClient(QObject* parent = nullptr);

  // 连接到 VPS
  void connectToServer(const QString& url);

  // 发送注册包
  void registerHost(const QString& localIp, int quicPort);

 private slots:
  void onConnected();
  void onTextMessageReceived(const QString& message);

 private:
  QWebSocket m_webSocket;
};

#endif  // SIGNALINGCLIENT_H
