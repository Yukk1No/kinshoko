import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionPreview } from "../bindings/SubscriptionPreview";

export const DAY = 24 * 60 * 60 * 1000;

export type ArtistIndexCard = {
  artist: Artist;
  subscription: Subscription;
  preview: SubscriptionPreview | undefined;
  gone: boolean;
};

export const lastNew = (card: ArtistIndexCard) => card.preview?.lastReceivedAt ?? null;

export const artistId = (subscription: Subscription) =>
  subscription.target.kind === "pixivArtist" ? subscription.target.userId : "";
