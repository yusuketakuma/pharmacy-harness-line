type RichMenuBounds = {
  boundsX: number
  boundsY: number
  boundsWidth: number
  boundsHeight: number
}

export function richMenuAreaStyle(
  area: RichMenuBounds,
  size: 'large' | 'compact',
) {
  const height = size === 'large' ? 1686 : 843
  return {
    left: `${area.boundsX / 25}%`,
    top: `${area.boundsY * 100 / height}%`,
    width: `${area.boundsWidth / 25}%`,
    height: `${area.boundsHeight * 100 / height}%`,
  }
}
