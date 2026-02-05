package store

import (
	"log"
	"time"

	"quiclink-server/config"
)

// StartCleanupLoop 启动定期清理过期房间的任务
func StartCleanupLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	go func() {
		for range ticker.C {
			CleanupExpiredRooms()
		}
	}()
}

// CleanupExpiredRooms 清理过期房间
func CleanupExpiredRooms() {
	if config.Current.AppMode != "public" {
		return
	}

	ttl := time.Duration(config.Current.RoomTTLHours) * time.Hour
	// 如果配置为0或负数，可能意味着不清理？但这里默认48.
	// 防止极其短暂的配置错误，最低1小时? 不，按配置来。
	if ttl <= 0 {
		return
	}

	ManagerLock.Lock()
	defer ManagerLock.Unlock()

	now := time.Now()
	expiredCount := 0

	for id, room := range Rooms {
		// 只有 Public 模式下的非常驻房间才会被清理?
		// 暂时简单粗暴：创建时间超过 TTL 就清理
		// 除非它是 "public" 房间？ (可选保留)
		if id == "public" {
			continue
		}

		// 检查是否过期
		if now.Sub(room.CreatedAt) > ttl {
			// 首先通过互斥锁关闭房间内的所有连接?
			// 由于我们持有 ManagerLock，这会阻塞其他 GetRoom 操作，
			// 但 Close 连接可能耗时。
			// 简单做法：先从 map 删除，后续 room 对象被 GC，连接关闭可能需要手动触发。

			// 为了安全，先 Lock 房间，把所有连接踢掉
			room.mutex.Lock()
			for conn := range room.Clients {
				conn.Close()
			}
			room.Clients = make(map[Connection]bool) // 清空
			room.mutex.Unlock()

			delete(Rooms, id)
			expiredCount++
			log.Printf("🧹 Room Expired & Deleted: %s (Created: %s)", id, room.CreatedAt.Format(time.RFC3339))
		}
	}

	if expiredCount > 0 {
		log.Printf("🧹 Cleanup finished. Removed %d expired rooms.", expiredCount)
	}
}
