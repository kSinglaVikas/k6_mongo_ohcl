use('charts')

const CHUNK_DAYS = Number((typeof process !== 'undefined' && process.env.CHUNK_DAYS) || '7')

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function flattenInChunks(sourceCollectionName, targetCollectionName) {
  const source = db.getCollection(sourceCollectionName)
  const target = db.getCollection(targetCollectionName)

  const bounds = source.aggregate([
    {
      $group: {
        _id: null,
        minTs: { $min: '$ts' },
        maxTs: { $max: '$ts' },
        totalDocs: { $sum: 1 }
      }
    }
  ]).toArray()[0]

  if (!bounds || !bounds.minTs || !bounds.maxTs) {
    console.log(`Skipping ${sourceCollectionName}: no documents found`)
    return
  }

  console.log(`Flattening ${sourceCollectionName} -> ${targetCollectionName}`)
  console.log(`Source docs: ${bounds.totalDocs}, range: ${bounds.minTs.toISOString()} -> ${bounds.maxTs.toISOString()}`)
  console.log(`Chunk size: ${CHUNK_DAYS} day(s)`)

  target.drop()
  target.createIndex({ id: 1, date: 1 }, { unique: true })

  let chunkStart = bounds.minTs
  let chunkNumber = 0
  const endExclusive = new Date(bounds.maxTs.getTime() + 1)

  while (chunkStart < endExclusive) {
    const nextStart = addDays(chunkStart, CHUNK_DAYS)
    const chunkEnd = nextStart < endExclusive ? nextStart : endExclusive
    chunkNumber += 1

    console.log(
      `[${sourceCollectionName}] chunk ${chunkNumber}: ${chunkStart.toISOString()} -> ${chunkEnd.toISOString()}`
    )

    source.aggregate([
      {
        $match: {
          ts: { $gte: chunkStart, $lt: chunkEnd }
        }
      },
      { $sort: { id: 1, ts: 1 } },
      {
        $group: {
          _id: {
            id: '$id',
            date: {
              $dateTrunc: {
                date: '$ts',
                unit: 'day',
                timezone: 'Asia/Kolkata'
              }
            }
          },
          candles: {
            $push: {
              ts: '$ts',
              o: '$o',
              h: '$h',
              l: '$l',
              c: '$c'
            }
          },
          firstTs: { $first: '$ts' },
          lastTs: { $last: '$ts' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          id: '$_id.id',
          date: '$_id.date',
          interval: '1m',
          firstTs: 1,
          lastTs: 1,
          count: 1,
          data: { '1d': '$candles' }
        }
      },
      {
        $merge: {
          into: targetCollectionName,
          on: ['id', 'date'],
          whenMatched: 'replace',
          whenNotMatched: 'insert'
        }
      }
    ], { allowDiskUse: true })

    chunkStart = chunkEnd
  }

  console.log(`Done ${sourceCollectionName}: packed docs = ${target.countDocuments()}`)
}

flattenInChunks('historic-eq', 'historic-eq-packed')
flattenInChunks('oned-fno', 'oned-fno-packed')

console.log('Flattening oned-eq -> oned-eq-packed (single aggregation)')

db.getCollection("oned-eq").aggregate([
  { $sort: { id: 1, ts: 1 } },
  {
    $group: {
      _id: {
        id: "$id",
        tradeDate: {
          $dateTrunc: {
            date: "$ts",
            unit: "day",
            timezone: "Asia/Kolkata"
          }
        }
      },
      candles: {
        $push: {
          ts: "$ts",
          o: "$o",
          h: "$h",
          l: "$l",
          c: "$c"
        }
      },
      firstTs: { $first: "$ts" },
      lastTs: { $last: "$ts" },
      count: { $sum: 1 }
    }
  },
  {
    $project: {
      _id: 0,
      id: "$_id.id",
      tradeDate: "$_id.tradeDate",
      interval: "1m",
      firstTs: 1,
      lastTs: 1,
      count: 1,
      data: { "1d": "$candles" }
    }
  },
  { $out: "oned-eq-packed" }
], { allowDiskUse: true })

db.getCollection("oned-eq-packed").createIndex(
  { id: 1, tradeDate: 1 },
  { unique: true }
)

console.log('Done.')