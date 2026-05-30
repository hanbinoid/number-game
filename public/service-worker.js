self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Number Game', {
      body: data.body ?? "You've been overtaken!",
      icon: '/public/bg.gif',
    })
  );
});
