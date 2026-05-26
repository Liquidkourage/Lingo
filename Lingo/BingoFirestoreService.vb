Imports Google.Cloud.Firestore
Imports System.Linq
Imports System.Threading.Tasks

Public Class BingoFirestoreService
    Private ReadOnly db As FirestoreDb
    Public Property CurrentGameId As String

    Public Sub New()
        db = FirestoreDb.Create("liquidkourage-16fe5")
    End Sub

    Public Function StartNewGame() As String
        CurrentGameId = Guid.NewGuid().ToString("N")
        Dim gameRef = db.Collection("bingoGames").Document(CurrentGameId)
        gameRef.SetAsync(New Dictionary(Of String, Object) From {
            {"game_id", CurrentGameId},
            {"status", "active"},
            {"called", New List(Of Object)()},
            {"current_call", ""},
            {"updated_at", FieldValue.ServerTimestamp}
        }).GetAwaiter().GetResult()
        Return CurrentGameId
    End Function

    Public Sub EndGame()
        If String.IsNullOrEmpty(CurrentGameId) Then Return
        db.Collection("bingoGames").Document(CurrentGameId).UpdateAsync(New Dictionary(Of String, Object) From {
            {"status", "ended"},
            {"updated_at", FieldValue.ServerTimestamp}
        }).GetAwaiter().GetResult()
    End Sub

    Public Sub PublishCall(gameId As String, bingoCall As BingoCall)
        If bingoCall Is Nothing Then Return
        Dim callEntry As New Dictionary(Of String, Object) From {
            {"letter", bingoCall.Letter},
            {"number", bingoCall.Number},
            {"label", bingoCall.Label}
        }
        Dim gameRef = db.Collection("bingoGames").Document(gameId)
        gameRef.UpdateAsync(New Dictionary(Of String, Object) From {
            {"current_call", bingoCall.Label},
            {"called", FieldValue.ArrayUnion(callEntry)},
            {"updated_at", FieldValue.ServerTimestamp}
        }).GetAwaiter().GetResult()
    End Sub

    Public Sub SaveCard(card As BingoCard)
        If card Is Nothing OrElse String.IsNullOrEmpty(card.GameId) Then Return
        Dim docId = CardDocumentId(card.GameId, card.DisplayName)
        Dim gridRows As New List(Of Object)
        Dim markedRows As New List(Of Object)

        For row As Integer = 0 To 4
            Dim gridRow As New List(Of Object)
            Dim markedRow As New List(Of Object)
            For col As Integer = 0 To 4
                gridRow.Add(card.Grid(row, col))
                markedRow.Add(card.Marked(row, col))
            Next
            gridRows.Add(gridRow)
            markedRows.Add(markedRow)
        Next

        db.Collection("bingoCards").Document(docId).SetAsync(New Dictionary(Of String, Object) From {
            {"game_id", card.GameId},
            {"display_name", card.DisplayName},
            {"grid", gridRows},
            {"marked", markedRows},
            {"updated_at", FieldValue.ServerTimestamp}
        }, SetOptions.MergeAll).GetAwaiter().GetResult()
    End Sub

    Public Shared Function CardDocumentId(gameId As String, displayName As String) As String
        Dim safeName = System.Text.RegularExpressions.Regex.Replace(displayName.Trim(), "[^a-zA-Z0-9]", "_")
        If String.IsNullOrEmpty(safeName) Then safeName = "player"
        Return gameId + "_" + safeName
    End Function

    Public Function WebUrlForGame(gameId As String) As String
        Return BingoFeature.WebBaseUrl + "?game=" + Uri.EscapeDataString(gameId)
    End Function
End Class
