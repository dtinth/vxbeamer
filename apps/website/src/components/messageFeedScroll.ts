export function getMessageFeedScrollBehavior(hasScrolledInitially: boolean): ScrollBehavior {
  return hasScrolledInitially ? "smooth" : "auto";
}
